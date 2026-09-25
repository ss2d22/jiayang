// Package jiayang verifies who is calling your Jiayang Cloud app.
//
// It checks the X-Jiayang-Identity token the edge sends. X-Jiayang-Email and X-Jiayang-Role are
// for display only.
//
//	http.Handle("/", jiayang.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
//		user, _ := jiayang.UserFrom(r.Context())
//		fmt.Fprintf(w, "hello %s\n", user.Email)
//	})))
//
// Or check in a handler.
//
//	user, err := jiayang.RequireUser(r)
//	if err != nil {
//		http.Error(w, "unauthorized", http.StatusUnauthorized)
//		return
//	}
//
// A webhook delivery on a verified public path carries a token too, of its own kind.
// RequireWebhook(r, jiayang.ProviderStripe) checks it, and RequireUser refuses it.
//
// The platform sets JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL. Without them
// every request is refused.
//
// Docs: https://jiayang.cloud/docs/sdks/go/
package jiayang

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// IdentityHeader carries the edge's identity token.
const IdentityHeader = "X-Jiayang-Identity"

const (
	algorithm    = "RS256"
	maxAge       = 5 * time.Minute
	cooldown     = 10 * time.Second
	retry        = time.Second
	fetchTimeout = 3 * time.Second
	maxJWKSBytes = 1 << 20
	minRSABits   = 2048
)

// ErrUnauthorized is wrapped by every refusal. Respond with 401.
var ErrUnauthorized = errors.New("unauthorized")

func refuse(why string) error { return fmt.Errorf("%w: %s", ErrUnauthorized, why) }

// User is a verified caller. As JSON it's kind, sub, email, role and workspace_id, the names Python
// and Rust use, with a null email for a bypass token.
type User struct {
	// Kind is "user" for a person, "service" for a bypass token.
	Kind string `json:"kind"`
	// Sub is a stable id, either the person's platform id ("usr_…") or "service:<token id>".
	Sub string `json:"sub"`
	// Email is empty for service tokens.
	Email string `json:"email"`
	// Role is the caller's access to this app.
	Role        string `json:"role"`
	WorkspaceID string `json:"workspace_id"`
}

// MarshalJSON writes an empty Email as null, as Python writes None.
func (u User) MarshalJSON() ([]byte, error) {
	type fields User // without this method
	return json.Marshal(struct {
		fields
		Email *string `json:"email"`
	}{fields(u), orNull(u.Email)})
}

func orNull(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Role is what a caller may do with this app. The order matters: an owner can do what an editor
// can, and an editor what a viewer can.
type Role string

const (
	RoleViewer Role = "viewer"
	RoleEditor Role = "editor"
	RoleOwner  Role = "owner"
)

var rank = map[string]int{string(RoleViewer): 1, string(RoleEditor): 2, string(RoleOwner): 3}

// ErrForbidden is wrapped by a refusal about what the caller may do rather than who they are.
// Respond with 403.
var ErrForbidden = errors.New("forbidden")

// HasRole reports whether the caller has at least least.
//
// A role this version doesn't know counts for nothing, on either side: if the platform ever adds
// one, an app built against an older SDK refuses rather than guessing what it allows, and asking
// for a role that doesn't exist refuses too rather than letting everyone through.
func HasRole(u User, least Role) bool {
	need, known := rank[string(least)]
	return known && rank[u.Role] >= need
}

// RequireRole returns an error wrapping ErrForbidden unless the caller has at least least.
func RequireRole(u User, least Role) error {
	if !HasRole(u, least) {
		return fmt.Errorf("%w: this needs %s", ErrForbidden, least)
	}
	return nil
}

// Config is what a token is checked against.
type Config struct {
	AppID   string
	Issuer  string
	JWKSURL string
}

// ConfigFromEnv reads JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL.
func ConfigFromEnv() (Config, error) {
	c := Config{AppID: os.Getenv("JIAYANG_APP_ID"), Issuer: os.Getenv("JIAYANG_IDENTITY_ISSUER"), JWKSURL: os.Getenv("JIAYANG_JWKS_URL")}
	return c, c.check()
}

func (c Config) check() error {
	if c.AppID == "" || c.Issuer == "" || c.JWKSURL == "" {
		// Deny if any are missing, since there's nothing to check the token against.
		return refuse("JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL must be set")
	}
	return nil
}

// Verifier checks identity tokens for one app. It's safe for concurrent use.
type Verifier struct {
	config Config
	keys   *KeySet
	now    func() time.Time
}

// Option adjusts a Verifier.
type Option func(*Verifier)

// WithClock overrides the time tokens are checked at, for tests.
func WithClock(now func() time.Time) Option { return func(v *Verifier) { v.now = now } }

// WithKeySet overrides where keys come from, for tests or custom transports.
func WithKeySet(keys *KeySet) Option { return func(v *Verifier) { v.keys = keys } }

// NewVerifier returns a verifier for config, or an error if config is incomplete.
func NewVerifier(config Config, options ...Option) (*Verifier, error) {
	if err := config.check(); err != nil {
		return nil, err
	}
	v := &Verifier{config: config, now: time.Now}
	for _, option := range options {
		option(v)
	}
	if v.keys == nil {
		v.keys = NewKeySet(config.JWKSURL, nil)
	}
	return v, nil
}

// RequireUser returns the verified caller of r, or an error wrapping ErrUnauthorized.
func (v *Verifier) RequireUser(r *http.Request) (User, error) {
	token := r.Header.Get(IdentityHeader)
	if token == "" {
		return User{}, refuse("no identity token")
	}
	return v.Verify(token)
}

type identityClaims struct {
	jwt.RegisteredClaims
	Kind  string  `json:"kind"`
	Email *string `json:"email"`
	Role  *string `json:"role"`
	WID   *string `json:"wid"`
}

// Verify checks a token's signature, issuer, audience, expiry and claims.
func (v *Verifier) Verify(token string) (User, error) {
	var c identityClaims
	if _, err := v.parse(token, v.config.AppID, &c); err != nil {
		return User{}, err
	}
	if c.IssuedAt == nil || c.Subject == "" || (c.Kind != "user" && c.Kind != "service") {
		return User{}, refuse("invalid identity token")
	}
	if (c.Kind == "user" && c.Email == nil) || c.Role == nil || c.WID == nil {
		return User{}, refuse("invalid identity token")
	}
	user := User{Kind: c.Kind, Sub: c.Subject, Role: *c.Role, WorkspaceID: *c.WID}
	if c.Kind == "user" {
		user.Email = *c.Email
	}
	return user, nil
}

// parse runs the checks every token gets, whoever it's for, into claims, and returns the payload's
// claims as they were written.
func (v *Verifier) parse(token, audience string, claims jwt.Claims) (map[string]json.RawMessage, error) {
	parser := jwt.NewParser(
		// Pinned so the token's own alg header can't pick the algorithm.
		jwt.WithValidMethods([]string{algorithm}),
		jwt.WithIssuer(v.config.Issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(0),
		jwt.WithTimeFunc(v.now),
	)
	_, err := parser.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		kid, ok := t.Header["kid"].(string)
		if !ok || t.Method.Alg() != algorithm {
			return nil, errors.New("no usable kid")
		}
		return v.keys.Key(kid)
	})
	raw, ok := wellFormed(token)
	if err != nil || !ok {
		return nil, refuse("invalid identity token")
	}
	return raw, nil
}

// claimNames are the edge's claim names, in the case it writes them.
var claimNames = []string{
	"iss", "aud", "sub", "exp", "iat", "nbf", "jti", "kind", "email", "role", "wid",
	"provider", "pattern", "delivery", "signed_at",
}

// wellFormed rejects string-typed times, which the edge never writes, and claim names in another
// case ("EXP", "Kind"), which encoding/json would match. The other SDKs refuse those too. It
// returns the payload's claims as written.
func wellFormed(token string) (map[string]json.RawMessage, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, false
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(payload, &raw) != nil {
		return nil, false
	}
	for name := range raw {
		for _, ours := range claimNames {
			if name != ours && strings.EqualFold(name, ours) {
				return nil, false
			}
		}
	}
	for _, name := range []string{"exp", "iat", "nbf", "signed_at"} {
		value, ok := raw[name]
		if !ok {
			continue
		}
		var n json.Number
		if len(value) == 0 || value[0] == '"' || json.Unmarshal(value, &n) != nil {
			return nil, false
		}
	}
	return raw, true
}

// KeySet is the edge's public keys, cached for five minutes. An unknown kid triggers a refetch at
// most every ten seconds, so made-up kids can't cause a fetch storm. If the keys can't be fetched,
// verification fails.
type KeySet struct {
	url   string
	fetch func(url string) ([]byte, error)
	now   func() time.Time

	fetching sync.Mutex // one fetch at a time
	mu       sync.RWMutex
	keys     map[string]*rsa.PublicKey
	fetched  time.Time
	tried    time.Time
}

// NewKeySet fetches keys from url with fetch, or over HTTP with a short timeout when fetch is nil.
func NewKeySet(url string, fetch func(url string) ([]byte, error)) *KeySet {
	if fetch == nil {
		fetch = httpFetch
	}
	return &KeySet{url: url, fetch: fetch, now: time.Now}
}

// WithKeyClock overrides the key set's clock, for tests.
func (k *KeySet) WithKeyClock(now func() time.Time) *KeySet {
	k.now = now
	return k
}

var client = &http.Client{
	Timeout: fetchTimeout,
	// Keys come only from the configured URL. A redirect could go anywhere, even plain http.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func httpFetch(url string) ([]byte, error) {
	res, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS answered %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxJWKSBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxJWKSBytes {
		return nil, errors.New("JWKS too large")
	}
	return body, nil
}

func (k *KeySet) lookup(kid string, now time.Time) (key *rsa.PublicKey, known, fresh bool) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	key, known = k.keys[kid]
	fresh = !k.fetched.IsZero() && now.Sub(k.fetched) < maxAge
	return key, known, fresh
}

// Key returns the public key for kid.
func (k *KeySet) Key(kid string) (*rsa.PublicKey, error) {
	if key, known, fresh := k.lookup(kid, k.now()); known && fresh {
		return key, nil
	}
	k.fetching.Lock()
	defer k.fetching.Unlock()
	now := k.now()
	key, known, fresh := k.lookup(kid, now)
	wait := retry
	if fresh {
		wait = cooldown
	}
	if (!fresh || !known) && (k.tried.IsZero() || now.Sub(k.tried) >= wait) {
		k.tried = now
		body, err := k.fetch(k.url)
		var keys map[string]*rsa.PublicKey
		if err == nil {
			keys, err = parseJWKS(body)
		}
		k.mu.Lock()
		if err == nil {
			k.keys, k.fetched = keys, now
		} else if !fresh {
			k.keys = nil
		}
		k.mu.Unlock()
		key, known, fresh = k.lookup(kid, now)
	}
	if !fresh {
		return nil, refuse("couldn't fetch the identity keys")
	}
	if !known {
		return nil, refuse("unknown signing key")
	}
	return key, nil
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func parseJWKS(body []byte) (map[string]*rsa.PublicKey, error) {
	var doc struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, raw := range doc.Keys {
		var j jwk
		if json.Unmarshal(raw, &j) != nil || j.Kty != "RSA" || j.Kid == "" {
			continue
		}
		if (j.Use != "" && j.Use != "sig") || (j.Alg != "" && j.Alg != algorithm) {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(strings.TrimRight(j.N, "="))
		e, errE := base64.RawURLEncoding.DecodeString(strings.TrimRight(j.E, "="))
		if errN != nil || errE != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		key := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		if key.N.BitLen() < minRSABits || key.E < 3 {
			continue
		}
		keys[j.Kid] = key
	}
	return keys, nil
}

// ---- webhooks -----------------------------------------------------------------------------------

// Provider is who signs a webhook the platform can check for you.
type Provider string

const (
	ProviderStripe           Provider = "stripe"
	ProviderGitHub           Provider = "github"
	ProviderSlack            Provider = "slack"
	ProviderShopify          Provider = "shopify"
	ProviderStandardWebhooks Provider = "standard_webhooks"
	ProviderHMACSHA256       Provider = "hmac_sha256"
)

var knownProviders = map[Provider]bool{
	ProviderStripe: true, ProviderGitHub: true, ProviderSlack: true,
	ProviderShopify: true, ProviderStandardWebhooks: true, ProviderHMACSHA256: true,
}

// Webhook is a delivery whose signature the platform checked before it reached your app, on a
// public path with a verifier. It isn't a person: it has no email and no role.
//
// As JSON it's provider, pattern, delivery, signed_at and workspace_id, the names Python and Rust
// use. A delivery id or time the provider doesn't sign is null, and signed_at is unix seconds.
type Webhook struct {
	Provider Provider `json:"provider"`
	// Pattern is the public path pattern it arrived on, such as "/hooks/stripe".
	Pattern string `json:"pattern"`
	// Delivery is the provider's signed id for this delivery, empty when it signs none. Dedupe on it.
	Delivery string `json:"delivery"`
	// SignedAt is when the provider signed it, zero when it signs no time.
	SignedAt    time.Time `json:"signed_at"`
	WorkspaceID string    `json:"workspace_id"`
}

// MarshalJSON writes an empty Delivery and a zero SignedAt as null, and SignedAt in unix seconds,
// as Python and Rust hold them.
func (w Webhook) MarshalJSON() ([]byte, error) {
	type fields Webhook // without these methods
	out := struct {
		fields
		Delivery *string `json:"delivery"`
		SignedAt *int64  `json:"signed_at"`
	}{fields: fields(w), Delivery: orNull(w.Delivery)}
	if !w.SignedAt.IsZero() {
		seconds := w.SignedAt.Unix()
		out.SignedAt = &seconds
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads what MarshalJSON writes.
func (w *Webhook) UnmarshalJSON(data []byte) error {
	type fields Webhook
	var in struct {
		fields
		SignedAt *int64 `json:"signed_at"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return err
	}
	*w = Webhook(in.fields)
	if in.SignedAt != nil {
		w.SignedAt = time.Unix(*in.SignedAt, 0).UTC()
	}
	return nil
}

// A webhook's token is addressed to "webhook:<app id>", never to the app id alone, so a check
// written for people can't take a delivery for someone signed in.
const webhookAudience = "webhook:"

// maxExact is the largest integer every language reading a JSON number is sure to get back as
// written.
const maxExact = 1<<53 - 1

// RequireWebhook returns the webhook the platform verified for r, from one of providers, or an
// error wrapping ErrUnauthorized. A person's or a bypass token's identity is refused, as a
// webhook's is by RequireUser.
func (v *Verifier) RequireWebhook(r *http.Request, providers ...Provider) (Webhook, error) {
	token := r.Header.Get(IdentityHeader)
	if token == "" {
		return Webhook{}, refuse("no identity token")
	}
	return v.VerifyWebhook(token, providers...)
}

// VerifyWebhook checks a webhook token's signature, issuer, audience, expiry and claims, and that
// it came from one of providers. With no providers every token is refused.
func (v *Verifier) VerifyWebhook(token string, providers ...Provider) (Webhook, error) {
	// Named by the caller, so a Stripe route can't be handed a GitHub delivery because a pattern was
	// widened later.
	if len(providers) == 0 {
		return Webhook{}, refuse("no provider named")
	}
	var c jwt.RegisteredClaims
	raw, err := v.parse(token, webhookAudience+v.config.AppID, &c)
	if err != nil {
		return Webhook{}, err
	}
	invalid := refuse("invalid webhook token")
	if c.IssuedAt == nil || c.Subject == "" {
		return Webhook{}, invalid
	}
	// Read from the payload as written: encoding/json takes null for absent, and jwt takes a list
	// holding our audience where the edge writes a single string.
	kind, isKind := jsonString(raw["kind"])
	_, oneAudience := jsonString(raw["aud"])
	wid, isWID := jsonString(raw["wid"])
	if !isKind || kind != "webhook" || !oneAudience || !isWID {
		return Webhook{}, invalid
	}
	name, isName := jsonString(raw["provider"])
	provider := Provider(name)
	// A provider this version doesn't know matches nothing, even when the caller lists it.
	if !isName || !knownProviders[provider] || !listed(provider, providers) {
		return Webhook{}, refuse("not a webhook this route takes")
	}
	pattern, isPattern := jsonString(raw["pattern"])
	if !isPattern || pattern == "" {
		return Webhook{}, invalid
	}
	w := Webhook{Provider: provider, Pattern: pattern, WorkspaceID: wid}
	// Left out where the provider signs no id or no time. When there, each is what the edge writes.
	if value, ok := raw["delivery"]; ok {
		delivery, isDelivery := jsonString(value)
		if !isDelivery || delivery == "" {
			return Webhook{}, invalid
		}
		w.Delivery = delivery
	}
	if value, ok := raw["signed_at"]; ok {
		seconds, whole := wholeSeconds(value)
		if !whole {
			return Webhook{}, invalid
		}
		w.SignedAt = time.Unix(seconds, 0).UTC()
	}
	return w, nil
}

func listed(p Provider, providers []Provider) bool {
	for _, each := range providers {
		if each == p {
			return true
		}
	}
	return false
}

// jsonString is a claim written as a JSON string, and nothing else: not null, not a number.
func jsonString(value json.RawMessage) (string, bool) {
	var s string
	if len(value) == 0 || value[0] != '"' || json.Unmarshal(value, &s) != nil {
		return "", false
	}
	return s, true
}

// wholeSeconds is a whole, non-negative number of seconds. JSON has one number type, so 5.0 is 5
// here as it is in the SDKs that can't tell them apart.
func wholeSeconds(value json.RawMessage) (int64, bool) {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var decoded any
	if decoder.Decode(&decoded) != nil {
		return 0, false
	}
	n, ok := decoded.(json.Number)
	if !ok {
		return 0, false
	}
	if i, err := n.Int64(); err == nil {
		return i, i >= 0 && i <= maxExact
	}
	f, err := n.Float64()
	if err != nil || f != math.Trunc(f) || f < 0 || f > maxExact {
		return 0, false
	}
	return int64(f), true
}

type webhookKey struct{}

// WebhookMiddleware responds 401 to anything but a delivery the platform verified from one of
// providers, and otherwise passes the delivery to next in the request context (see WebhookFrom).
func (v *Verifier) WebhookMiddleware(providers ...Provider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			webhook, err := v.RequireWebhook(r, providers...)
			if err != nil {
				unauthorized(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), webhookKey{}, webhook)))
		})
	}
}

// WebhookFrom returns the delivery WebhookMiddleware verified.
func WebhookFrom(ctx context.Context) (Webhook, bool) {
	webhook, ok := ctx.Value(webhookKey{}).(Webhook)
	return webhook, ok
}

// ---- the default verifier, from the environment -------------------------------------------------

var (
	defaultOnce     sync.Once
	defaultVerifier *Verifier
	defaultErr      error
)

func fromEnv() (*Verifier, error) {
	defaultOnce.Do(func() {
		var config Config
		if config, defaultErr = ConfigFromEnv(); defaultErr == nil {
			defaultVerifier, defaultErr = NewVerifier(config)
		}
	})
	return defaultVerifier, defaultErr
}

// RequireUser returns the verified caller of r, checked against the environment's config.
func RequireUser(r *http.Request) (User, error) {
	v, err := fromEnv()
	if err != nil {
		return User{}, err
	}
	return v.RequireUser(r)
}

// RequireWebhook returns the webhook the platform verified for r, from one of providers, checked
// against the environment's config.
func RequireWebhook(r *http.Request, providers ...Provider) (Webhook, error) {
	v, err := fromEnv()
	if err != nil {
		return Webhook{}, err
	}
	return v.RequireWebhook(r, providers...)
}

// WebhookMiddleware is the package's Verifier.WebhookMiddleware, checked against the environment's
// config. Register it outside Middleware, which would refuse the delivery first:
//
//	mux.Handle("POST /hooks/stripe", jiayang.WebhookMiddleware(jiayang.ProviderStripe)(stripeHook))
//	mux.Handle("/", jiayang.Middleware(app))
func WebhookMiddleware(providers ...Provider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			v, err := fromEnv()
			if err != nil {
				unauthorized(w)
				return
			}
			v.WebhookMiddleware(providers...)(next).ServeHTTP(w, r)
		})
	}
}

type contextKey struct{}

// Middleware responds 401 without a valid identity, and otherwise passes the caller to next in
// the request context (see UserFrom).
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, err := fromEnv()
		if err != nil {
			unauthorized(w)
			return
		}
		v.Middleware(next).ServeHTTP(w, r)
	})
}

// Middleware is the package Middleware for this verifier.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := v.RequireUser(r)
		if err != nil {
			unauthorized(w)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, user)))
	})
}

// Requires is Middleware that also refuses a caller who may not do this: 401 without an identity,
// 403 with one that isn't enough.
//
//	r.With(jiayang.Requires(jiayang.RoleEditor)).Post("/orders", placeOrder)
func Requires(least Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			v, err := fromEnv()
			if err != nil {
				unauthorized(w)
				return
			}
			v.Requires(least)(next).ServeHTTP(w, r)
		})
	}
}

// Requires is the package Requires for this verifier.
func (v *Verifier) Requires(least Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := v.RequireUser(r)
			if err != nil {
				unauthorized(w)
				return
			}
			if err := RequireRole(user, least); err != nil {
				forbidden(w, least)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, user)))
		})
	}
}

// UserFrom returns the caller Middleware verified.
func UserFrom(ctx context.Context) (User, bool) {
	user, ok := ctx.Value(contextKey{}).(User)
	return user, ok
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

// forbidden answers the plain-text 403 every SDK answers, `forbidden: this needs editor`, with no
// newline after it, which http.Error would add.
func forbidden(w http.ResponseWriter, least Role) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, "forbidden: this needs "+string(least))
}
