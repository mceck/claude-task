package runner

import (
	"os"
	"path/filepath"
)

// outbox keeps a Job's unacked messages in order. Past the memory limit new messages
// spill to a file in the Agent Volume so a long disconnect can't exhaust memory.
type outbox struct {
	entries   []entry
	memBytes  int
	limit     int
	spillPath string
	spill     *os.File
	spillEnd  int64
}

type entry struct {
	seq  int64
	data []byte // nil when spilled
	off  int64
	n    int
}

func newOutbox(limit int, spillPath string) *outbox {
	return &outbox{limit: limit, spillPath: spillPath}
}

func (o *outbox) add(seq int64, data []byte) error {
	if o.spill == nil && o.memBytes+len(data) <= o.limit {
		o.entries = append(o.entries, entry{seq: seq, data: data})
		o.memBytes += len(data)
		return nil
	}
	if o.spill == nil {
		if err := os.MkdirAll(filepath.Dir(o.spillPath), 0o700); err != nil {
			return err
		}
		f, err := os.OpenFile(o.spillPath, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		o.spill = f
	}
	if _, err := o.spill.WriteAt(data, o.spillEnd); err != nil {
		return err
	}
	o.entries = append(o.entries, entry{seq: seq, off: o.spillEnd, n: len(data)})
	o.spillEnd += int64(len(data))
	return nil
}

// ack drops every message up to and including seq.
func (o *outbox) ack(seq int64) {
	i := 0
	for i < len(o.entries) && o.entries[i].seq <= seq {
		o.memBytes -= len(o.entries[i].data)
		i++
	}
	o.entries = o.entries[i:]
	if len(o.entries) == 0 && o.spill != nil {
		o.close()
	}
}

func (o *outbox) each(fn func([]byte) error) error {
	for _, e := range o.entries {
		data := e.data
		if data == nil {
			data = make([]byte, e.n)
			if _, err := o.spill.ReadAt(data, e.off); err != nil {
				return err
			}
		}
		if err := fn(data); err != nil {
			return err
		}
	}
	return nil
}

func (o *outbox) empty() bool { return len(o.entries) == 0 }

func (o *outbox) close() {
	if o.spill != nil {
		o.spill.Close()
		os.Remove(o.spillPath)
		o.spill = nil
		o.spillEnd = 0
	}
}
