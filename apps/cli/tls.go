package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

var (
	tlsEnabled     bool
	tlsFingerprint string
)

func setupTLS(dir string, lanIPs []string) (*tls.Config, string, error) {
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	// Try loading existing certificate
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err == nil && len(cert.Certificate) > 0 {
		x509Cert, parseErr := x509.ParseCertificate(cert.Certificate[0])
		if parseErr == nil && time.Now().Before(x509Cert.NotAfter) {
			fp := sha256.Sum256(cert.Certificate[0])
			fpHex := hex.EncodeToString(fp[:])
			return &tls.Config{
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS12,
			}, fpHex, nil
		}
	}

	// Generate fresh ECDSA P-256 key pair
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, "", fmt.Errorf("failed to generate ecdsa key: %w", err)
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return nil, "", fmt.Errorf("failed to generate serial: %w", err)
	}

	ipList := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	for _, ipStr := range lanIPs {
		if parsed := net.ParseIP(ipStr); parsed != nil {
			ipList = append(ipList, parsed)
		}
	}

	hostname, _ := os.Hostname()
	dnsList := []string{"localhost", "p2p-link.local"}
	if hostname != "" {
		dnsList = append(dnsList, hostname)
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"P2P Link Local LAN"},
			CommonName:   "P2P Link Local Server",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           ipList,
		DNSNames:              dnsList,
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create certificate: %w", err)
	}

	// Write PEM files
	_ = os.MkdirAll(dir, 0755)
	certOut, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return nil, "", err
	}
	_ = pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	certOut.Close()

	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, "", err
	}
	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return nil, "", err
	}
	_ = pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
	keyOut.Close()

	tlsCert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, "", err
	}

	fp := sha256.Sum256(derBytes)
	fpHex := hex.EncodeToString(fp[:])

	return &tls.Config{
		Certificates: []tls.Certificate{tlsCert},
		MinVersion:   tls.VersionTLS12,
	}, fpHex, nil
}

