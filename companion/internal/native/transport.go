package native

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

const MaxMessage = 512 * 1024

type Message struct {
	Version  int             `json:"version"`
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	RunID    string          `json:"runId,omitempty"`
	ActionID string          `json:"actionId,omitempty"`
	Payload  json.RawMessage `json:"payload"`
}

type Transport struct {
	in  io.Reader
	out io.Writer
	mu  sync.Mutex
}

func New(in io.Reader, out io.Writer) *Transport { return &Transport{in: in, out: out} }
func (t *Transport) Read() (Message, error) {
	var m Message
	var n uint32
	if err := binary.Read(t.in, binary.LittleEndian, &n); err != nil {
		return m, err
	}
	if n == 0 || n > MaxMessage {
		return m, errors.New("native message exceeds size limit")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(t.in, b); err != nil {
		return m, err
	}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return m, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return m, errors.New("native envelope contains trailing data")
	}
	if m.Version != 1 || m.ID == "" || len(m.ID) > 128 || m.Type == "" || len(m.Type) > 64 || len(m.Payload) == 0 || m.Payload[0] != '{' {
		return m, errors.New("invalid protocol envelope")
	}
	return m, nil
}
func (t *Transport) Write(m Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > MaxMessage {
		return errors.New("outgoing native message exceeds size limit")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := binary.Write(t.out, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = t.out.Write(b)
	return err
}
