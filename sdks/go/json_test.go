package jiayang

// A caller or a delivery an app writes as JSON is spelled the way sdks/testdata/vectors.json spells
// it, as the other SDKs spell it, and reads back as it was.

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// spellings are the vectors' callers and deliveries as written.
type spellings struct {
	Valid []struct {
		User json.RawMessage `json:"user"`
	} `json:"valid"`
	WebhookValid []struct {
		Webhook json.RawMessage `json:"webhook"`
	} `json:"webhook_valid"`
}

func loadSpellings(t *testing.T) spellings {
	t.Helper()
	raw, err := os.ReadFile("../testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var s spellings
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func writesAs(t *testing.T, value any, want json.RawMessage) {
	t.Helper()
	written, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got, expected any
	if err := json.Unmarshal(written, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("wrote %s, want %s", written, want)
	}
}

func TestUserJSON(t *testing.T) {
	v, s := loadVectors(t), loadSpellings(t)
	for i, c := range v.Valid {
		t.Run(c.Name, func(t *testing.T) {
			user, err := v.verify(t, c)
			if err != nil {
				t.Fatal(err)
			}
			writesAs(t, user, s.Valid[i].User)
			var back User
			if err := json.Unmarshal(s.Valid[i].User, &back); err != nil || back != user {
				t.Fatalf("read %+v (err %v), want %+v", back, err, user)
			}
		})
	}
}

func TestWebhookJSON(t *testing.T) {
	v, s := loadVectors(t), loadSpellings(t)
	for i, c := range v.WebhookValid {
		t.Run(c.Name, func(t *testing.T) {
			hook, err := v.verifyWebhook(t, c)
			if err != nil {
				t.Fatal(err)
			}
			writesAs(t, hook, s.WebhookValid[i].Webhook)
			var back Webhook
			if err := json.Unmarshal(s.WebhookValid[i].Webhook, &back); err != nil || back != hook {
				t.Fatalf("read %+v (err %v), want %+v", back, err, hook)
			}
		})
	}
}
