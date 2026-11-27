package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func formatFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	hexStr := strings.ToUpper(hex.EncodeToString(sum[:]))
	parts := make([]string, 0, len(sum))
	for i := 0; i < len(hexStr); i += 2 {
		parts = append(parts, hexStr[i:i+2])
	}
	return strings.Join(parts, ":")
}

func normalizeFingerprint(raw string) string {
	s := strings.ToUpper(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, "SHA256:")
	s = strings.TrimPrefix(s, "SHA-256:")
	s = strings.ReplaceAll(s, ":", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}

// fetchRootCert downloads Jarvy's public root CA certificate (DER) when connecting over HTTPS.
func fetchRootCert(server string) (pemStr string, fingerprint string, ok bool, err error) {
	if !strings.HasPrefix(server, "https://") {
		return "", "", false, nil
	}
	client, err := newHTTPClient(nil, true, 15*time.Second)
	if err != nil {
		return "", "", false, err
	}
	resp, err := client.Get(server + "/api/connection/root.crt")
	if err != nil {
		return "", "", false, fmt.Errorf("failed to fetch root certificate from %s: %w", server, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", false, fmt.Errorf("root certificate endpoint returned HTTP %d", resp.StatusCode)
	}
	der, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", "", false, err
	}
	if _, err := x509.ParseCertificate(der); err != nil {
		return "", "", false, fmt.Errorf("server returned invalid X.509 certificate: %w", err)
	}
	fp := formatFingerprint(der)
	block := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return string(block), fp, true, nil
}

func verifyTrust(server, expectedFP string) (*string, error) {
	pemStr, gotFP, hasRoot, err := fetchRootCert(server)
	if err != nil {
		return nil, err
	}
	if !hasRoot {
		return nil, nil
	}
	if strings.TrimSpace(expectedFP) != "" {
		if normalizeFingerprint(gotFP) != normalizeFingerprint(expectedFP) {
			return nil, fmt.Errorf("certificate fingerprint mismatch!\n  expected: %s\n  received: %s", expectedFP, gotFP)
		}
		fmt.Printf("Verified Jarvy root certificate (SHA-256 %s)\n", gotFP)
		return &pemStr, nil
	}
	fmt.Printf("Jarvy's root certificate: SHA-256 %s\n", gotFP)
	fmt.Println("Check that it matches the fingerprint in Jarvy's Settings -> Network.")
	fmt.Print("Does it match? (y/N) ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	ans := strings.ToLower(strings.TrimSpace(line))
	if ans != "y" && ans != "yes" {
		return nil, errors.New("aborted: certificate was not confirmed")
	}
	return &pemStr, nil
}

func enrollWithToken(server, pairingToken, expectedFP, deviceName string) (*DeviceConfig, error) {
	caPEM, err := verifyTrust(server, expectedFP)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(deviceName) == "" {
		deviceName, _ = os.Hostname()
	}
	client, err := newHTTPClient(caPEM, false, 20*time.Second)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{
		"token": pairingToken,
		"name":  strings.TrimSpace(deviceName),
	})
	resp, err := client.Post(server+"/api/devices/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("enrollment request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated {
		var apiErr struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &apiErr)
		msg := apiErr.Error
		if msg == "" {
			msg = apiErr.Message
		}
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return nil, fmt.Errorf("enrollment failed (HTTP %d): %s", resp.StatusCode, msg)
	}
	var out struct {
		Device struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"device"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Token == "" {
		return nil, errors.New("server returned invalid enrollment response")
	}
	return &DeviceConfig{
		Server: server,
		Token:  out.Token,
		CA:     caPEM,
		Name:   out.Device.Name,
	}, nil
}

func loginWithPassword(server, expectedFP, deviceName string) (*DeviceConfig, error) {
	caPEM, err := verifyTrust(server, expectedFP)
	if err != nil {
		return nil, err
	}
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("Jarvy username: ")
	username, _ := reader.ReadString('\n')
	username = strings.TrimSpace(username)
	fmt.Print("Password: ")
	password, _ := reader.ReadString('\n')
	password = strings.TrimSpace(password)

	if strings.TrimSpace(deviceName) == "" {
		deviceName, _ = os.Hostname()
	}
	client, err := newHTTPClient(caPEM, false, 20*time.Second)
	if err != nil {
		return nil, err
	}
	loginBody, _ := json.Marshal(map[string]string{"username": username, "password": password})
	resp, err := client.Post(server+"/api/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sign-in failed (HTTP %d)", resp.StatusCode)
	}
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	regBody, _ := json.Marshal(map[string]string{"name": strings.TrimSpace(deviceName)})
	req, _ := http.NewRequest("POST", server+"/api/environments/devices", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", strings.Join(cookies, "; "))
	regResp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer regResp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(regResp.Body, 1<<20))
	if regResp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("device registration failed (HTTP %d): %s", regResp.StatusCode, string(raw))
	}
	var out struct {
		Device struct {
			Name string `json:"name"`
		} `json:"device"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Token == "" {
		return nil, errors.New("invalid device registration response")
	}
	return &DeviceConfig{
		Server: server,
		Token:  out.Token,
		CA:     caPEM,
		Name:   out.Device.Name,
	}, nil
}
