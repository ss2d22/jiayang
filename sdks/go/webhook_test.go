package jiayang

// RequireWebhook from the tenant side: what it takes, and that it fails closed like RequireUser.

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// webhookToken is what the edge sends with a delivery on a verified path.
func webhookToken(t *testing.T, extra map[string]any) string {
	t.Helper()
	c := jwt.MapClaims{
		"iss": issuer, "aud": "webhook:" + app, "sub": "webhook:0c000000-0000-4000-8000-0000000000f1",
		"kind": "webhook", "wid": "0b000000-0000-4000-8000-00000000000a",
		"provider": "stripe", "pattern": "/hooks/stripe", "delivery": "evt_1", "signed_at": now.Unix() - 1,
		"iat": now.Unix(), "exp": now.Unix() + 60,
	}
	for k, v := range extra {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	token.Header["kid"] = "identity-k1"
	token.Header["typ"] = "webhook+jwt"
	s, err := token.SignedString(edge)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRequireWebhookNamesTheDelivery(t *testing.T) {
	f := setup(t)
	r := httptest.NewRequest("POST", "/hooks/stripe", nil)
	r.Header.Set("x-jiayang-identity", webhookToken(t, nil))
	got, err := f.verifier.RequireWebhook(r, ProviderStripe)
	if err != nil {
		t.Fatal(err)
	}
	want := Webhook{Provider: ProviderStripe, Pattern: "/hooks/stripe", Delivery: "evt_1", SignedAt: time.Unix(now.Unix()-1, 0).UTC(), WorkspaceID: "0b000000-0000-4000-8000-00000000000a"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestRequireWebhookRefusesARequestWithNoTokenWhateverElseItCarries(t *testing.T) {
	f := setup(t)
	r := httptest.NewRequest("POST", "/hooks/stripe", nil)
	r.Header.Set("X-Jiayang-Email", "alice@example.com")
	r.Header.Set("Stripe-Signature", "t=1,v1=00")
	if _, err := f.verifier.RequireWebhook(r, ProviderStripe); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
}

// No providers is a refusal, not a panic, and costs no fetch.
func TestNoProviderRefusesEverythingWithoutFetchingAKey(t *testing.T) {
	f := setup(t)
	if _, err := f.verifier.VerifyWebhook(webhookToken(t, nil)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
	if _, err := f.verifier.VerifyWebhook(webhookToken(t, nil), []Provider{}...); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
	if f.jwks.fetches != 0 {
		t.Fatalf("fetched the keys %d times", f.jwks.fetches)
	}
}

func TestANameThisVersionDoesNotKnowMatchesNothing(t *testing.T) {
	f := setup(t)
	for _, listed := range []Provider{"", "Stripe", "paddle", "stripe "} {
		if _, err := f.verifier.VerifyWebhook(webhookToken(t, nil), listed); !errors.Is(err, ErrUnauthorized) {
			t.Errorf("%q: got %v", listed, err)
		}
	}
	token := webhookToken(t, map[string]any{"provider": "paddle"})
	if _, err := f.verifier.VerifyWebhook(token, "paddle"); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("a provider it doesn't know, listed: got %v", err)
	}
}

// The same token is a user's no more than a user's token is a webhook.
func TestEachRefusesTheOthersToken(t *testing.T) {
	f := setup(t)
	f.refused(t, webhookToken(t, nil))
	if _, err := f.verifier.VerifyWebhook(good(t, nil), ProviderStripe); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("a person passed as a webhook: %v", err)
	}
}

func TestVerifyWebhookRefusesWhenTheKeysCantBeFetched(t *testing.T) {
	f := setup(t)
	f.jwks.down = true
	if _, err := f.verifier.VerifyWebhook(webhookToken(t, nil), ProviderStripe); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
}

func TestWebhookMiddlewareAnswers401AndPassesTheDelivery(t *testing.T) {
	f := setup(t)
	reached := false
	handler := f.verifier.WebhookMiddleware(ProviderStripe, ProviderGitHub)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		webhook, ok := WebhookFrom(r.Context())
		if !ok {
			t.Fatal("no webhook in context")
		}
		if _, isUser := UserFrom(r.Context()); isUser {
			t.Fatal("a webhook came with a user")
		}
		fmt.Fprint(w, webhook.Delivery)
	}))
	for _, c := range []struct {
		what  string
		token string
		want  int
	}{
		{"a stripe delivery", webhookToken(t, nil), 200},
		{"a person", good(t, nil), 401},
		{"nobody", "", 401},
		{"a slack delivery", webhookToken(t, map[string]any{"provider": "slack"}), 401},
	} {
		reached = false
		r := httptest.NewRequest("POST", "/hooks/stripe", nil)
		if c.token != "" {
			r.Header.Set(IdentityHeader, c.token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != c.want || reached != (c.want == 200) {
			t.Errorf("%s: got %d, reached %v", c.what, w.Code, reached)
		}
		if w.Code == 200 && w.Body.String() != "evt_1" {
			t.Errorf("%s: got %q", c.what, w.Body.String())
		}
		if w.Code != 200 && w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: a refusal was cacheable", c.what)
		}
	}
}

// How the README mounts it: the webhook's route on the outer mux, outside Middleware, which would
// refuse the delivery before the webhook's handler saw it.
func TestAWebhookRouteBesideMiddleware(t *testing.T) {
	f := setup(t)
	app := http.NewServeMux()
	app.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		user, _ := UserFrom(r.Context())
		fmt.Fprint(w, "hello "+user.Email)
	})
	mux := http.NewServeMux()
	mux.Handle("POST /hooks/stripe", f.verifier.WebhookMiddleware(ProviderStripe)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webhook, _ := WebhookFrom(r.Context())
		fmt.Fprint(w, "took "+webhook.Delivery)
	})))
	mux.Handle("/", f.verifier.Middleware(app))

	for _, c := range []struct {
		path, token, want string
		code              int
	}{
		{"/hooks/stripe", webhookToken(t, nil), "took evt_1", 200},
		{"/hooks/stripe", good(t, nil), "", 401},
		{"/", good(t, nil), "hello alice@example.com", 200},
		{"/", webhookToken(t, nil), "", 401},
	} {
		r := httptest.NewRequest("POST", c.path, nil)
		r.Header.Set(IdentityHeader, c.token)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != c.code || (c.code == 200 && w.Body.String() != c.want) {
			t.Errorf("%s: got %d %q", c.path, w.Code, w.Body.String())
		}
	}
}

func TestWebhookFromIsEmptyWithoutTheMiddleware(t *testing.T) {
	if _, ok := WebhookFrom(httptest.NewRequest("POST", "/", nil).Context()); ok {
		t.Fatal("found a webhook nobody verified")
	}
}
