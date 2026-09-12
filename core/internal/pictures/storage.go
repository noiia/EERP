package pictures

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"

	"core/internal/types"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ObjectStore is the call-site interface the handler needs from object storage.
// The S3 implementation below is the only production one; tests stub it.
type ObjectStore interface {
	Put(ctx context.Context, key, contentType string, size int64, body io.Reader) error
	// Get returns the object's bytes and content type; the caller closes the reader.
	Get(ctx context.Context, key string) (io.ReadCloser, string, error)
	Delete(ctx context.Context, key string) error
}

// s3Store implements ObjectStore over any S3-compatible endpoint via the minio
// client (Garage in dev; the provider is swappable by config alone).
type s3Store struct {
	client *minio.Client
	bucket string
}

// NewS3Store builds the store from the shared config's s3_* fields. The
// endpoint carries an explicit scheme (http for the dev Garage node).
func NewS3Store(cfg *types.Config) (ObjectStore, error) {
	endpoint, err := url.Parse(cfg.S3Endpoint)
	if err != nil {
		return nil, fmt.Errorf("pictures: parse s3_endpoint: %w", err)
	}
	client, err := minio.New(endpoint.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""),
		Secure: endpoint.Scheme == "https",
		Region: cfg.S3Region,
	})
	if err != nil {
		return nil, fmt.Errorf("pictures: build s3 client: %w", err)
	}
	return &s3Store{client: client, bucket: cfg.S3Bucket}, nil
}

// S3Configured reports whether the config carries a usable object store.
// All-empty means "no object storage": the picture endpoints stay unmounted.
func S3Configured(cfg *types.Config) bool {
	return strings.TrimSpace(cfg.S3Endpoint) != "" && strings.TrimSpace(cfg.S3Bucket) != ""
}

func (s *s3Store) Put(ctx context.Context, key, contentType string, size int64, body io.Reader) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, body, size,
		minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return fmt.Errorf("pictures: put %s: %w", key, err)
	}
	return nil
}

func (s *s3Store) Get(ctx context.Context, key string) (io.ReadCloser, string, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, "", fmt.Errorf("pictures: get %s: %w", key, err)
	}
	// GetObject is lazy: Stat forces the first round-trip so a missing object
	// surfaces here (as a typed error) instead of midway through streaming.
	info, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		return nil, "", fmt.Errorf("pictures: stat %s: %w", key, err)
	}
	return obj, info.ContentType, nil
}

func (s *s3Store) Delete(ctx context.Context, key string) error {
	if err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("pictures: delete %s: %w", key, err)
	}
	return nil
}
