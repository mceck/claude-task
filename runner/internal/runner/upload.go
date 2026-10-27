package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"time"

	"claude-task/runner/internal/protocol"
)

const (
	// ATTACHMENT_MAX_BYTES in shared: the backend refuses larger files.
	maxUploadBytes = 25 << 20
	// The backend's tool call waits this long (UPLOAD_TIMEOUT_MS); a slower upload is discarded anyway.
	uploadTimeout = 60 * time.Second
	sniffBytes     = 512
)

// uploadFile is a requested file that passed the checks, opened and ready to stream.
type uploadFile struct {
	f           *os.File
	name        string
	contentType string
	head        []byte // the first bytes, already read for sniffing
}

// upload answers a job.upload: one multipart POST with the manifest, then a part per file that
// passed the checks. A failed POST is reported as a Runner note; the backend's tool call times out.
func (j *job) upload(m *protocol.Incoming) {
	manifest, files := j.openUploads(m.Files)
	defer func() {
		for _, u := range files {
			u.f.Close()
		}
	}()
	if err := j.postUpload(m.URL, manifest, files); err != nil {
		log.Printf("job %s: upload %s: %v", j.id, m.RequestID, err)
		j.note(fmt.Sprintf("[runner] could not upload files: %v\n", err))
	}
}

// openUploads checks every requested path, in order: a regular file (symlinks followed) of at
// most maxUploadBytes, relative paths resolved against the Worktree.
func (j *job) openUploads(paths []protocol.UploadFile) ([]protocol.UploadManifestEntry, []uploadFile) {
	manifest := make([]protocol.UploadManifestEntry, 0, len(paths))
	var files []uploadFile
	for _, p := range paths {
		u, err := j.openUpload(p.Path)
		entry := protocol.UploadManifestEntry{Path: p.Path}
		if err != nil {
			entry.Error = err.Error()
		} else {
			files = append(files, u)
		}
		manifest = append(manifest, entry)
	}
	return manifest, files
}

func (j *job) openUpload(path string) (uploadFile, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(j.worktreeDir(), path)
	}
	info, err := os.Stat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return uploadFile{}, errors.New("not found")
	case err != nil:
		return uploadFile{}, err
	case !info.Mode().IsRegular():
		return uploadFile{}, errors.New("not a regular file")
	case info.Size() > maxUploadBytes:
		return uploadFile{}, errors.New("larger than 25 MB")
	}
	f, err := os.Open(path)
	if err != nil {
		return uploadFile{}, err
	}
	head := make([]byte, sniffBytes)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		f.Close()
		return uploadFile{}, err
	}
	head = head[:n]
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		// Falls back to application/octet-stream itself.
		contentType = http.DetectContentType(head)
	}
	return uploadFile{f: f, name: filepath.Base(path), contentType: contentType, head: head}, nil
}

// postUpload streams the multipart body, so files never sit in memory whole.
func (j *job) postUpload(url string, manifest []protocol.UploadManifestEntry, files []uploadFile) error {
	ctx, cancel := context.WithTimeout(context.Background(), uploadTimeout)
	defer cancel()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	written := make(chan struct{})
	go func() {
		defer close(written)
		pw.CloseWithError(writeUpload(mw, manifest, files))
	}()
	// Unblocks the writer whatever happened to the request, before the files are closed.
	defer func() {
		pr.CloseWithError(errors.New("upload ended"))
		<-written
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+j.r.cfg.Token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return nil
}

func writeUpload(mw *multipart.Writer, manifest []protocol.UploadManifestEntry, files []uploadFile) error {
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := mw.WriteField("manifest", string(data)); err != nil {
		return err
	}
	for _, u := range files {
		part, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {multipart.FileContentDisposition("file", u.name)},
			"Content-Type":        {u.contentType},
		})
		if err != nil {
			return err
		}
		if _, err := part.Write(u.head); err != nil {
			return err
		}
		// A file that grew past the limit since it was checked fails the upload.
		n, err := io.Copy(part, io.LimitReader(u.f, maxUploadBytes-int64(len(u.head))+1))
		if err != nil {
			return err
		}
		if int64(len(u.head))+n > maxUploadBytes {
			return fmt.Errorf("%s grew larger than 25 MB", u.name)
		}
	}
	return mw.Close()
}

// note adds a Runner note to the Job's stderr, unless the Job already sent its last message.
func (j *job) note(s string) {
	j.r.mu.Lock()
	defer j.r.mu.Unlock()
	if !j.finished {
		j.r.emitLocked(j, "job.stderr", map[string]any{"chunk": s})
	}
}
