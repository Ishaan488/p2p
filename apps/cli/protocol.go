package main

type Message struct {
	Version        int         `json:"version"`
	Type           string      `json:"type"`
	ID             string      `json:"id"`
	Timestamp      int64       `json:"timestamp"`
	Payload        interface{} `json:"payload"`
	TargetDeviceID string      `json:"targetDeviceId,omitempty"`
}

type TextPayload struct {
	Text string `json:"text"`
}
