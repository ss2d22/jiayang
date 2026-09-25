package jiayang

// Hostile cases from the tenant side. Only the edge's tokens for this app may pass.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	app      = "0a000000-0000-4000-8000-000000000001"
	otherApp = "0a000000-0000-4000-8000-000000000002"
	issuer   = "https://edge.example.com"
	jwksURL  = "https://edge.example.com/.well-known/jwks.json"
)

var (
	now      = time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	edge     = newKey(2048)
	rotated  = newKey(2048)
	attacker = newKey(2048)
	config   = Config{AppID: app, Issuer: issuer, JWKSURL: jwksURL}
)

func newKey(bits int) *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		panic(err)
	}
	return key
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func publicJWK(kid string, key *rsa.PrivateKey, extra map[string]any) map[string]any {
	j := map[string]any{
		"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
		"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes()),
	}
	for k, v := range extra {
		j[k] = v
	}
	return j
}

type jwks struct {
	keys    []map[string]any
	down    bool
	fetches int
	clock   time.Time
}

func (j *jwks) fetch(url string) ([]byte, error) {
	if url != jwksURL {
		return nil, fmt.Errorf("unexpected url %s", url)
	}
	j.fetches++
	if j.down {
		return nil, errors.New("network down")
	}
	return json.Marshal(map[string]any{"keys": j.keys})
}

type fixture struct {
	jwks     *jwks
	verifier *Verifier
}

func setup(t *testing.T) *fixture {
	t.Helper()
	j := &jwks{keys: []map[string]any{publicJWK("identity-k1", edge, nil)}, clock: now}
	keys := NewKeySet(jwksURL, j.fetch).WithKeyClock(func() time.Time { return j.clock })
	v, err := NewVerifier(config, WithKeySet(keys), WithClock(func() time.Time { return now }))
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{jwks: j, verifier: v}
}

func claims(extra map[string]any) jwt.MapClaims {
	c := jwt.MapClaims{
		"iss": issuer, "aud": app, "sub": "access-sub-alice", "email": "alice@example.com",
		"kind": "user", "role": "editor", "wid": "0b000000-0000-4000-8000-00000000000a",
		"iat": now.Unix(), "exp": now.Unix() + 60,
	}
	for k, v := range extra {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	return c
}

func sign(t *testing.T, c jwt.MapClaims, key *rsa.PrivateKey, kid string, method jwt.SigningMethod) string {
	t.Helper()
	token := jwt.NewWithClaims(method, c)
	token.Header["kid"] = kid
	s, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func good(t *testing.T, extra map[string]any) string {
	return sign(t, claims(extra), edge, "identity-k1", jwt.SigningMethodRS256)
}

func (f *fixture) refused(t *testing.T, token string) {
	t.Helper()
	if user, err := f.verifier.Verify(token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("accepted %q as %+v (err %v)", token, user, err)
	}
}

func TestReturnsTheVerifiedCaller(t *testing.T) {
	f := setup(t)
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-jiayang-identity", good(t, nil))
	user, err := f.verifier.RequireUser(r)
	if err != nil {
		t.Fatal(err)
	}
	want := User{Kind: "user", Sub: "access-sub-alice", Email: "alice@example.com", Role: "editor", WorkspaceID: "0b000000-0000-4000-8000-00000000000a"}
	if user != want {
		t.Fatalf("got %+v", user)
	}
}

func TestServiceCallerHasNoEmail(t *testing.T) {
	f := setup(t)
	user, err := f.verifier.Verify(good(t, map[string]any{"kind": "service", "sub": "service:bt_ci", "email": "ignored@example.com"}))
	if err != nil || user.Kind != "service" || user.Sub != "service:bt_ci" || user.Email != "" {
		t.Fatalf("got %+v, %v", user, err)
	}
}

func TestRefusesARequestWithNoTokenWhateverElseItCarries(t *testing.T) {
	f := setup(t)
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Jiayang-Email", "alice@example.com")
	r.Header.Set("X-Jiayang-Role", "owner")
	if _, err := f.verifier.RequireUser(r); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
}

func TestRefusesWhenTheAppIsntConfigured(t *testing.T) {
	for _, c := range []Config{{Issuer: issuer, JWKSURL: jwksURL}, {AppID: app, JWKSURL: jwksURL}, {AppID: app, Issuer: issuer}} {
		if _, err := NewVerifier(c); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	t.Setenv("JIAYANG_APP_ID", "")
	if _, err := ConfigFromEnv(); !errors.Is(err, ErrUnauthorized) {
		t.Fatal(err)
	}
}

func TestMiddlewareAnswers401AndPassesTheCaller(t *testing.T) {
	f := setup(t)
	handler := f.verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := UserFrom(r.Context())
		if !ok {
			t.Fatal("no user in context")
		}
		fmt.Fprint(w, user.Email)
	}))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("got %d", w.Code)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set(IdentityHeader, good(t, nil))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "alice@example.com" {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
}

func TestHostileTokens(t *testing.T) {
	f := setup(t)
	for _, token := range []string{"", "abc", "a.b", "a.b.c", "a.b.c.d", "..."} {
		f.refused(t, token)
	}

	header := func(h map[string]any) string { b, _ := json.Marshal(h); return b64(b) }
	body, _ := json.Marshal(claims(nil))

	t.Run("alg none", func(t *testing.T) {
		f.refused(t, header(map[string]any{"alg": "none", "kid": "identity-k1"})+"."+b64(body)+".")
		none := jwt.NewWithClaims(jwt.SigningMethodNone, claims(nil))
		none.Header["kid"] = "identity-k1"
		s, _ := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
		f.refused(t, s)
	})

	t.Run("HS256 keyed with the public key", func(t *testing.T) {
		der, _ := x509.MarshalPKIXPublicKey(&edge.PublicKey)
		secret := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
		signing := header(map[string]any{"alg": "HS256", "kid": "identity-k1", "typ": "JWT"}) + "." + b64(body)
		mac := hmac.New(sha256.New, secret)
		mac.Write([]byte(signing))
		f.refused(t, signing+"."+b64(mac.Sum(nil)))
	})

	t.Run("other RSA algorithms, even with our key", func(t *testing.T) {
		for _, m := range []jwt.SigningMethod{jwt.SigningMethodRS384, jwt.SigningMethodRS512, jwt.SigningMethodPS256} {
			f.refused(t, sign(t, claims(nil), edge, "identity-k1", m))
		}
	})

	t.Run("valid signature from the wrong key", func(t *testing.T) {
		f.refused(t, sign(t, claims(nil), attacker, "identity-k1", jwt.SigningMethodRS256))
		f.refused(t, sign(t, claims(nil), attacker, "attacker", jwt.SigningMethodRS256))
	})

	cases := map[string]map[string]any{
		"another app's audience":     {"aud": otherApp},
		"another app in a list":      {"aud": []string{otherApp}},
		"the wrong issuer":           {"iss": "https://evil.example.com"},
		"not yet valid":              {"nbf": now.Unix() + 30},
		"no exp":                     {"exp": nil},
		"no iat":                     {"iat": nil},
		"no aud":                     {"aud": nil},
		"no iss":                     {"iss": nil},
		"exp as a string":            {"exp": fmt.Sprint(now.Unix() + 60)},
		"no kind":                    {"kind": nil},
		"an unknown kind":            {"kind": "admin"},
		"a kind that isn't a string": {"kind": 1},
		"a user with no email":       {"email": nil},
		"no role":                    {"role": nil},
		"no workspace":               {"wid": nil},
		"an empty sub":               {"sub": ""},
		"a numeric sub":              {"sub": 42},
		"exp as a bool":              {"exp": true},
		"a kind in another case":     {"kind": nil, "Kind": "user"},
		"a second exp in capitals":   {"EXP": now.Unix() + 3600},
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) { f.refused(t, good(t, extra)) })
	}
}

func TestExpiredAndReplayedAfterExpiry(t *testing.T) {
	f := setup(t)
	token := good(t, nil)
	if _, err := f.verifier.Verify(token); err != nil {
		t.Fatal(err)
	}
	for _, later := range []time.Duration{60 * time.Second, time.Hour} {
		at := now.Add(later)
		v, _ := NewVerifier(config, WithKeySet(f.verifier.keys), WithClock(func() time.Time { return at }))
		if _, err := v.Verify(token); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("accepted %s later", later)
		}
	}
}

func TestPicksUpARotatedKey(t *testing.T) {
	f := setup(t)
	if _, err := f.verifier.Verify(good(t, nil)); err != nil {
		t.Fatal(err)
	}
	f.jwks.keys = []map[string]any{publicJWK("identity-k2", rotated, nil), publicJWK("identity-k1", edge, nil)}
	f.jwks.clock = f.jwks.clock.Add(11 * time.Second)
	if _, err := f.verifier.Verify(sign(t, claims(nil), rotated, "identity-k2", jwt.SigningMethodRS256)); err != nil {
		t.Fatal(err)
	}
}

func TestMadeUpKidsDontBecomeAStreamOfFetches(t *testing.T) {
	f := setup(t)
	if _, err := f.verifier.Verify(good(t, nil)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		f.refused(t, sign(t, claims(nil), attacker, fmt.Sprintf("made-up-%d", i), jwt.SigningMethodRS256))
	}
	if f.jwks.fetches != 1 {
		t.Fatalf("%d fetches", f.jwks.fetches)
	}
}

func TestADownEndpointIsAskedAtMostOncePerCooldownForNewKids(t *testing.T) {
	f := setup(t)
	if _, err := f.verifier.Verify(good(t, nil)); err != nil {
		t.Fatal(err)
	}
	f.jwks.clock = f.jwks.clock.Add(11 * time.Second)
	f.jwks.down = true
	for i := 0; i < 50; i++ {
		f.refused(t, sign(t, claims(nil), attacker, fmt.Sprintf("made-up-%d", i), jwt.SigningMethodRS256))
	}
	if f.jwks.fetches != 2 {
		t.Fatalf("%d fetches", f.jwks.fetches)
	}
	if _, err := f.verifier.Verify(good(t, nil)); err != nil {
		t.Fatalf("the cached keys still serve: %v", err)
	}
}

func TestNeverFollowsARedirect(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"keys": []map[string]any{publicJWK("identity-k1", edge, nil)}})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/jwks" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		w.Write(body)
	}))
	defer server.Close()
	verify := func(path string) error {
		c := Config{AppID: app, Issuer: issuer, JWKSURL: server.URL + path}
		v, _ := NewVerifier(c, WithClock(func() time.Time { return now }))
		_, err := v.Verify(good(t, nil))
		return err
	}
	if err := verify("/jwks"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("followed the redirect: %v", err)
	}
	if err := verify("/elsewhere"); err != nil {
		t.Fatalf("the keys themselves verify: %v", err)
	}
}

func TestRefusesAnOversizedKeySet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, 2<<20))
	}))
	defer server.Close()
	if _, err := NewKeySet(server.URL, nil).Key("identity-k1"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal(err)
	}
}

func TestDeniesWhenTheKeysCantBeFetched(t *testing.T) {
	f := setup(t)
	f.jwks.down = true
	f.refused(t, good(t, nil))
}

func TestDeniesOnceCachedKeysExpireAndTheEndpointIsDown(t *testing.T) {
	f := setup(t)
	if _, err := f.verifier.Verify(good(t, nil)); err != nil {
		t.Fatal(err)
	}
	f.jwks.down = true
	f.jwks.clock = f.jwks.clock.Add(301 * time.Second)
	f.refused(t, good(t, nil))
}

func TestCachesAndRefetchesAfterFiveMinutes(t *testing.T) {
	f := setup(t)
	token := good(t, nil)
	for i := 0; i < 5; i++ {
		if _, err := f.verifier.Verify(token); err != nil {
			t.Fatal(err)
		}
	}
	if f.jwks.fetches != 1 {
		t.Fatalf("%d fetches", f.jwks.fetches)
	}
	f.jwks.clock = f.jwks.clock.Add(301 * time.Second)
	if _, err := f.verifier.Verify(token); err != nil || f.jwks.fetches != 2 {
		t.Fatalf("%d fetches, %v", f.jwks.fetches, err)
	}
}

func TestIgnoresKeysThatArentRSASigningKeysOrAreTooSmall(t *testing.T) {
	f := setup(t)
	small := newKey(1024)
	f.jwks.keys = []map[string]any{
		publicJWK("identity-k1", edge, map[string]any{"use": "enc"}),
		publicJWK("identity-k2", rotated, map[string]any{"alg": "RS512"}),
		publicJWK("small", small, nil),
		{"kty": "oct", "kid": "hmac", "k": b64([]byte("secret"))},
	}
	f.refused(t, good(t, nil))
	f.refused(t, sign(t, claims(nil), rotated, "identity-k2", jwt.SigningMethodRS256))
	f.refused(t, sign(t, claims(nil), small, "small", jwt.SigningMethodRS256))
}
