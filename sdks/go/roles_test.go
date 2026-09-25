package jiayang

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func who(role string) User {
	return User{Kind: "user", Sub: "u1", Email: "a@example.com", Role: role, WorkspaceID: "w1"}
}

func TestAnOwnerCanDoWhatAnEditorCan(t *testing.T) {
	for _, c := range []struct {
		role    string
		allowed []Role
		refused []Role
	}{
		{"viewer", []Role{RoleViewer}, []Role{RoleEditor, RoleOwner}},
		{"editor", []Role{RoleViewer, RoleEditor}, []Role{RoleOwner}},
		{"owner", []Role{RoleViewer, RoleEditor, RoleOwner}, nil},
	} {
		for _, least := range c.allowed {
			if !HasRole(who(c.role), least) {
				t.Errorf("%s should be at least %s", c.role, least)
			}
		}
		for _, least := range c.refused {
			if HasRole(who(c.role), least) {
				t.Errorf("%s should not be %s", c.role, least)
			}
		}
	}
}

// If the platform ever adds a role, an app built against an older SDK must refuse rather than
// guess what it allows.
func TestARoleThisVersionDoesNotKnowAllowsNothing(t *testing.T) {
	for _, unknown := range []string{"superuser", "", "OWNER", "admin"} {
		if HasRole(who(unknown), RoleViewer) {
			t.Errorf("%q allowed something", unknown)
		}
	}
}

func TestRequireRoleSaysWhichOne(t *testing.T) {
	if err := RequireRole(who("owner"), RoleEditor); err != nil {
		t.Fatalf("an owner was refused editor: %v", err)
	}
	err := RequireRole(who("viewer"), RoleEditor)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("want ErrForbidden, got %v", err)
	}
	if errors.Is(err, ErrUnauthorized) {
		t.Fatal("a role refusal is not an identity refusal")
	}
}

// The middleware shape every net/http router takes: chi and friends use it as-is, and Echo wraps
// it. What it has to get right is telling the two refusals apart.
func TestRequiresAnswers401WithoutAnIdentityAnd403WithoutTheRole(t *testing.T) {
	f := setup(t)
	reached := false
	handler := f.verifier.Requires(RoleEditor)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		user, _ := UserFrom(r.Context())
		fmt.Fprint(w, user.Email)
	}))

	for _, c := range []struct {
		what  string
		token string
		want  int
	}{
		{"no identity", "", 401},
		{"a viewer", good(t, map[string]any{"role": "viewer"}), 403},
		{"an editor", good(t, nil), 200},
		{"an owner", good(t, map[string]any{"role": "owner"}), 200},
	} {
		reached = false
		r := httptest.NewRequest("GET", "/", nil)
		if c.token != "" {
			r.Header.Set(IdentityHeader, c.token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s got %d, want %d", c.what, w.Code, c.want)
		}
		if reached != (c.want == 200) {
			t.Errorf("%s reached the handler: %v", c.what, reached)
		}
		if w.Code != 200 && w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: a refusal was cacheable", c.what)
		}
	}
}

// The other side of the same rule. rank[] gives an unknown role 0, so asking for one used to be
// a check every caller passed.
func TestAskingForARoleThatDoesNotExistAllowsNobody(t *testing.T) {
	for _, unknown := range []Role{"admin", "", "EDITOR", "superuser"} {
		for _, has := range []string{"viewer", "editor", "owner"} {
			if HasRole(who(has), unknown) {
				t.Errorf("%q let a %s through", unknown, has)
			}
			if err := RequireRole(who(has), unknown); !errors.Is(err, ErrForbidden) {
				t.Errorf("%q: want ErrForbidden, got %v", unknown, err)
			}
		}
	}
}
