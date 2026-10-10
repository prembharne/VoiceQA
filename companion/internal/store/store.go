package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	DB  *sql.DB
	Dir string
	mu  sync.Mutex
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "artifacts"), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "voiceqa.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
	CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(kind,id));
	CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,body TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
	PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{DB: db, Dir: dir}, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) Put(kind, id string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = s.DB.Exec(`INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated=CURRENT_TIMESTAMP`, kind, id, string(b))
	return e
}
func (s *Store) Get(kind, id string, v any) error {
	var b string
	e := s.DB.QueryRow(`SELECT body FROM records WHERE kind=? AND id=?`, kind, id).Scan(&b)
	if e != nil {
		return e
	}
	return json.Unmarshal([]byte(b), v)
}
func (s *Store) List(kind string) ([]json.RawMessage, error) {
	rows, e := s.DB.Query(`SELECT body FROM records WHERE kind=? ORDER BY rowid DESC LIMIT 100`, kind)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	r := []json.RawMessage{}
	for rows.Next() {
		var b string
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		r = append(r, json.RawMessage(b))
	}
	return r, rows.Err()
}
func (s *Store) Event(run string, v any) (int64, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return 0, e
	}
	res, e := s.DB.Exec(`INSERT INTO events(run_id,body) VALUES(?,?)`, run, string(b))
	if e != nil {
		return 0, e
	}
	return res.LastInsertId()
}
func (s *Store) Artifact(id string) string { return filepath.Join(s.Dir, "artifacts", id+".bin") }
func (s *Store) WriteArtifact(id string, b []byte) error {
	if len(id) != 32 {
		return errors.New("invalid artifact ID")
	}
	return os.WriteFile(s.Artifact(id), b, 0600)
}
func (s *Store) ReadArtifact(id string) ([]byte, error) {
	if len(id) != 32 {
		return nil, errors.New("invalid artifact ID")
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'f') || (c >= '0' && c <= '9')) {
			return nil, errors.New("invalid artifact ID")
		}
	}
	return os.ReadFile(s.Artifact(id))
}
