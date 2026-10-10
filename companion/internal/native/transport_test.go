package native

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"testing"
)

func TestFramingRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := New(nil, &buf)
	m := Message{Version: 1, ID: "one", Type: "hello", Payload: json.RawMessage(`{"name":"नमस्ते"}`)}
	if e := w.Write(m); e != nil {
		t.Fatal(e)
	}
	r := New(&buf, io.Discard)
	got, e := r.Read()
	if e != nil {
		t.Fatal(e)
	}
	if string(got.Payload) != string(m.Payload) {
		t.Fatal("UTF-8 payload changed")
	}
}
func TestRejectOversizeBeforeAllocation(t *testing.T) {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint32(MaxMessage+1))
	if _, e := New(&b, io.Discard).Read(); e == nil {
		t.Fatal("oversized message accepted")
	}
}
func TestRejectTruncatedPayload(t *testing.T) {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint32(20))
	b.WriteString("{}")
	if _, e := New(&b, io.Discard).Read(); e == nil {
		t.Fatal("truncated message accepted")
	}
}
func TestRejectWrongProtocol(t *testing.T) {
	var b bytes.Buffer
	w := New(nil, &b)
	_ = w.Write(Message{Version: 2, ID: "id", Type: "hello", Payload: json.RawMessage(`{}`)})
	if _, e := New(&b, io.Discard).Read(); e == nil {
		t.Fatal("wrong version accepted")
	}
}
func TestRejectUnknownEnvelopeFields(t *testing.T) {
	var b bytes.Buffer
	payload := []byte(`{"version":1,"id":"id","type":"hello","payload":{},"code":"unsafe"}`)
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(payload)))
	b.Write(payload)
	if _, e := New(&b, io.Discard).Read(); e == nil {
		t.Fatal("unknown envelope fields accepted")
	}
}
