package jiayang

// The token cases in sdks/testdata/vectors.json, shared by every SDK.

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type vectorCase struct {
	Name  string          `json:"name"`
	Token string          `json:"token"`
	Now   *int64          `json:"now"`
	JWKS  json.RawMessage `json:"jwks"`
	User  *struct {
		Kind        string  `json:"kind"`
		Sub         string  `json:"sub"`
		Email       *string `json:"email"`
		Role        string  `json:"role"`
		WorkspaceID string  `json:"workspace_id"`
		AgentName   *string `json:"agent_name"`
	} `json:"user"`
}

type webhookCase struct {
	Name      string   `json:"name"`
	Token     string   `json:"token"`
	Now       *int64   `json:"now"`
	Providers []string `json:"providers"`
	Webhook   *struct {
		Provider    string  `json:"provider"`
		Pattern     string  `json:"pattern"`
		Delivery    *string `json:"delivery"`
		SignedAt    *int64  `json:"signed_at"`
		WorkspaceID string  `json:"workspace_id"`
	} `json:"webhook"`
}

type vectorFile struct {
	Config struct {
		AppID   string `json:"app_id"`
		Issuer  string `json:"issuer"`
		JWKSURL string `json:"jwks_url"`
	} `json:"config"`
	Now     int64           `json:"now"`
	JWKS    json.RawMessage `json:"jwks"`
	Valid   []vectorCase    `json:"valid"`
	Invalid []vectorCase    `json:"invalid"`

	WebhookValid   []webhookCase `json:"webhook_valid"`
	WebhookInvalid []webhookCase `json:"webhook_invalid"`

	Origins []struct {
		Name    string  `json:"name"`
		OK      bool    `json:"ok"`
		Issuer  string  `json:"issuer"`
		JWKSURL string  `json:"jwks_url"`
		Dev     *string `json:"dev"`
	} `json:"origins"`
	Dev struct {
		Issuer  string `json:"issuer"`
		JWKSURL string `json:"jwks_url"`
		Token   string `json:"token"`
		User    struct {
			Sub   string `json:"sub"`
			Email string `json:"email"`
			Role  string `json:"role"`
		} `json:"user"`
	} `json:"dev"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("../testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func (v vectorFile) verifier(t *testing.T, jwks json.RawMessage, now *int64) *Verifier {
	t.Helper()
	body := v.JWKS
	if jwks != nil {
		body = jwks
	}
	at := time.Unix(v.Now, 0)
	if now != nil {
		at = time.Unix(*now, 0)
	}
	keys := NewKeySet(v.Config.JWKSURL, func(string) ([]byte, error) { return body, nil }).WithKeyClock(func() time.Time { return at })
	verifier, err := NewVerifier(Config{AppID: v.Config.AppID, Issuer: v.Config.Issuer, JWKSURL: v.Config.JWKSURL}, WithKeySet(keys), WithClock(func() time.Time { return at }))
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}

func (v vectorFile) verify(t *testing.T, c vectorCase) (User, error) {
	t.Helper()
	return v.verifier(t, c.JWKS, c.Now).Verify(c.Token)
}

func (v vectorFile) verifyWebhook(t *testing.T, c webhookCase) (Webhook, error) {
	t.Helper()
	providers := make([]Provider, len(c.Providers))
	for i, name := range c.Providers {
		providers[i] = Provider(name)
	}
	return v.verifier(t, nil, c.Now).VerifyWebhook(c.Token, providers...)
}

func TestSharedVectorsAccepted(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Valid {
		t.Run(c.Name, func(t *testing.T) {
			got, err := v.verify(t, c)
			if err != nil {
				t.Fatal(err)
			}
			email := ""
			if c.User.Email != nil {
				email = *c.User.Email
			}
			agent := ""
			if c.User.AgentName != nil {
				agent = *c.User.AgentName
			}
			want := User{Kind: c.User.Kind, Sub: c.User.Sub, Email: email, Role: c.User.Role, WorkspaceID: c.User.WorkspaceID, AgentName: agent}
			if got != want {
				t.Fatalf("got %+v, want %+v", got, want)
			}
			if got.IsAgent() != (c.User.AgentName != nil) {
				t.Fatalf("IsAgent is %v for %+v", got.IsAgent(), got)
			}
		})
	}
}

func TestSharedVectorsRefused(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Invalid {
		t.Run(c.Name, func(t *testing.T) {
			if got, err := v.verify(t, c); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("accepted as %+v (err %v)", got, err)
			}
		})
	}
}

func TestSharedWebhookVectorsAccepted(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.WebhookValid {
		t.Run(c.Name, func(t *testing.T) {
			got, err := v.verifyWebhook(t, c)
			if err != nil {
				t.Fatal(err)
			}
			want := Webhook{Provider: Provider(c.Webhook.Provider), Pattern: c.Webhook.Pattern, WorkspaceID: c.Webhook.WorkspaceID}
			if c.Webhook.Delivery != nil {
				want.Delivery = *c.Webhook.Delivery
			}
			if c.Webhook.SignedAt != nil {
				want.SignedAt = time.Unix(*c.Webhook.SignedAt, 0).UTC()
			}
			if got != want {
				t.Fatalf("got %+v, want %+v", got, want)
			}
		})
	}
}

func TestSharedWebhookVectorsRefused(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.WebhookInvalid {
		t.Run(c.Name, func(t *testing.T) {
			if got, err := v.verifyWebhook(t, c); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("accepted as %+v (err %v)", got, err)
			}
		})
	}
}

// An app in a language we ship no SDK for checks the token with whatever JWT library it has:
// signature, issuer, audience, expiry. Addressed to the app, that check must not pass a webhook.
func TestAGenericCheckThatTheAudienceIsTheAppRefusesWebhooks(t *testing.T) {
	v := loadVectors(t)
	keys, err := parseJWKS(v.JWKS)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.WebhookValid {
		parser := jwt.NewParser(
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithIssuer(v.Config.Issuer),
			jwt.WithAudience(v.Config.AppID),
			jwt.WithTimeFunc(func() time.Time { return time.Unix(v.Now, 0) }),
		)
		_, err := parser.Parse(c.Token, func(*jwt.Token) (any, error) { return keys["identity-k1"], nil })
		if !errors.Is(err, jwt.ErrTokenInvalidAudience) || !strings.Contains(err.Error(), "aud") {
			t.Errorf("%s: %v", c.Name, err)
		}
	}
}

// An environment holding exactly these, as the process would have them.
func environment(vars map[string]string) func(string) string {
	return func(name string) string { return vars[name] }
}

func (v vectorFile) env(issuer, jwksURL string, dev *string) func(string) string {
	vars := map[string]string{"JIAYANG_APP_ID": v.Config.AppID, "JIAYANG_IDENTITY_ISSUER": issuer, "JIAYANG_JWKS_URL": jwksURL}
	if dev != nil {
		vars["JIAYANG_DEV"] = *dev
	}
	return environment(vars)
}

func TestSharedOriginVectors(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Origins {
		t.Run(c.Name, func(t *testing.T) {
			config, err := configFrom(v.env(c.Issuer, c.JWKSURL, c.Dev))
			if c.OK && err != nil {
				t.Fatalf("refused: %v", err)
			}
			if !c.OK && (!errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "JIAYANG_DEV=1")) {
				t.Fatalf("taken as %+v (err %v)", config, err)
			}
			// A config built by hand is held to the same rule.
			if _, err := NewVerifier(config); c.OK != (err == nil) {
				t.Fatalf("NewVerifier disagrees: %v", err)
			}
		})
	}
}

func (v vectorFile) devVerifier(t *testing.T, config Config) (*Verifier, *bool) {
	t.Helper()
	fetched := false
	keys := NewKeySet(config.JWKSURL, func(string) ([]byte, error) { fetched = true; return v.JWKS, nil })
	at := time.Unix(v.Now, 0)
	verifier, err := NewVerifier(config, WithKeySet(keys.WithKeyClock(func() time.Time { return at })), WithClock(func() time.Time { return at }))
	if err != nil {
		t.Fatal(err)
	}
	return verifier, &fetched
}

func TestATokenFromJiayangDevUnderJiayangDev(t *testing.T) {
	v := loadVectors(t)
	one := "1"
	config, err := configFrom(v.env(v.Dev.Issuer, v.Dev.JWKSURL, &one))
	if err != nil {
		t.Fatal(err)
	}
	verifier, _ := v.devVerifier(t, config)
	user, err := verifier.Verify(v.Dev.Token)
	if err != nil {
		t.Fatal(err)
	}
	if user.Sub != v.Dev.User.Sub || user.Email != v.Dev.User.Email || user.Role != v.Dev.User.Role {
		t.Fatalf("got %+v", user)
	}
}

// Production: the same token and the same dev config, without the variable only jiayang dev sets.
// Refused before any key is asked for, in the package's own functions too.
func TestATokenFromJiayangDevIsRefusedWithoutJiayangDev(t *testing.T) {
	v := loadVectors(t)
	if _, err := configFrom(v.env(v.Dev.Issuer, v.Dev.JWKSURL, nil)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("taken: %v", err)
	}
	if _, err := NewVerifier(Config{AppID: v.Config.AppID, Issuer: v.Dev.Issuer, JWKSURL: v.Dev.JWKSURL}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("taken by hand: %v", err)
	}

	t.Setenv("JIAYANG_APP_ID", v.Config.AppID)
	t.Setenv("JIAYANG_IDENTITY_ISSUER", v.Dev.Issuer)
	t.Setenv("JIAYANG_JWKS_URL", v.Dev.JWKSURL)
	t.Setenv("JIAYANG_DEV", "")
	if _, err := ConfigFromEnv(); !errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "JIAYANG_DEV=1") {
		t.Fatalf("taken from the environment: %v", err)
	}
}

func TestATokenFromJiayangDevIsRefusedAgainstThePlatformIssuer(t *testing.T) {
	v := loadVectors(t)
	verifier, fetched := v.devVerifier(t, Config{AppID: v.Config.AppID, Issuer: v.Config.Issuer, JWKSURL: v.Config.JWKSURL, Dev: true})
	if _, err := verifier.Verify(v.Dev.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("taken: %v", err)
	}
	if !*fetched {
		t.Fatal("refused before its signature was checked, so this says nothing about the issuer")
	}
}
