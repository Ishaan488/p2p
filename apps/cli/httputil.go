package main

import (
	"encoding/json"
	"io"
	"net/http"
)

// Small HTTP helpers shared by the handlers.

const maxJSONBody = 64 << 10

func enableCORS(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readJSONBody is for the endpoints that run before a session exists.
func readJSONBody(r *http.Request, v interface{}) error {
	return json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(v)
}
