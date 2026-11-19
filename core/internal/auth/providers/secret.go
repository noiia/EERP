// Package providers implements external ERP sign-in (ADR-030): LDAP and OIDC
// authenticate a person and return an ExternalIdentity; Provisioner links or
// creates the ERP user and syncs its roles; the auth handler issues the
// session. Settings live in app_settings "auth.methods".
package providers

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/hkdf"
)

// ErrSecret: a sealed secret can't be opened (wrong master_key, corrupt value).
var ErrSecret = errors.New("providers: cannot open secret")

const sealedPrefix = "v1:"

// SecretBox encrypts provider secrets at rest with a key derived from
// master_key, so an app_settings dump never reveals a bind password or
// client secret. Changing master_key makes stored secrets unreadable.
type SecretBox struct{ aead cipher.AEAD }

func NewSecretBox(masterKey string) (*SecretBox, error) {
	if masterKey == "" {
		return nil, errors.New("providers: empty master key")
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, []byte(masterKey), nil, []byte("eerp/auth-secrets")), key); err != nil {
		return nil, fmt.Errorf("providers: derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretBox{aead: aead}, nil
}

func (b *SecretBox) Seal(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return sealedPrefix + base64.StdEncoding.EncodeToString(out), nil
}

func (b *SecretBox) Open(sealed string) (string, error) {
	raw, ok := strings.CutPrefix(sealed, sealedPrefix)
	if !ok {
		return "", ErrSecret
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) < b.aead.NonceSize() {
		return "", ErrSecret
	}
	plain, err := b.aead.Open(nil, data[:b.aead.NonceSize()], data[b.aead.NonceSize():], nil)
	if err != nil {
		return "", ErrSecret
	}
	return string(plain), nil
}
