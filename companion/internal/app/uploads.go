package app

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func (a *App) handleUpload(m native.Message) (any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, u := range a.uploads {
		if time.Since(u.Created) > 2*time.Minute {
			delete(a.uploads, id)
		}
	}
	switch m.Type {
	case "upload.begin":
		var p struct {
			Size int    `json:"size"`
			MIME string `json:"mime"`
			SHA  string `json:"sha"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if p.Size <= 0 || p.Size > 16*1024*1024 || len(a.uploads) >= 4 || len(p.SHA) != 64 {
			return nil, errors.New("upload limit exceeded")
		}
		id := core.ID()
		a.uploads[id] = &upload{Size: p.Size, MIME: p.MIME, SHA: p.SHA, Created: time.Now()}
		return map[string]any{"id": id}, nil
	case "upload.chunk":
		var p struct {
			ID   string `json:"id"`
			Seq  int    `json:"seq"`
			Data string `json:"data"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		u := a.uploads[p.ID]
		if u == nil || p.Seq != u.Next {
			return nil, errors.New("unexpected chunk sequence")
		}
		b, e := base64.StdEncoding.DecodeString(p.Data)
		if e != nil || len(b) > 192*1024 || len(u.Data)+len(b) > u.Size {
			return nil, errors.New("invalid chunk")
		}
		u.Data = append(u.Data, b...)
		u.Next++
		return map[string]any{"next": u.Next}, nil
	case "upload.complete":
		var p struct {
			ID string `json:"id"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		u := a.uploads[p.ID]
		if u == nil {
			return nil, errors.New("unknown upload")
		}
		delete(a.uploads, p.ID)
		sum := sha256.Sum256(u.Data)
		if len(u.Data) != u.Size || hex.EncodeToString(sum[:]) != u.SHA {
			return nil, errors.New("upload checksum mismatch")
		}
		if e := a.Store.WriteArtifact(p.ID, u.Data); e != nil {
			return nil, e
		}
		_ = a.Store.Put("artifact", p.ID, map[string]any{"id": p.ID, "mime": u.MIME, "size": u.Size})
		return map[string]any{"artifactId": p.ID}, nil
	}
	return nil, errors.New("invalid upload operation")
}
