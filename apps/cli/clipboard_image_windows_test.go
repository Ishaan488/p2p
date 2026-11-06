//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"
)

// A 2x2 24-bit DIB must convert to a decodable PNG with the right colours.
func TestDIBToPNG_24Bit(t *testing.T) {
	const w, h = 2, 2
	dib := make([]byte, 40)
	binary.LittleEndian.PutUint32(dib[0:], 40)
	binary.LittleEndian.PutUint32(dib[4:], w)
	binary.LittleEndian.PutUint32(dib[8:], h)
	binary.LittleEndian.PutUint16(dib[12:], 1)
	binary.LittleEndian.PutUint16(dib[14:], 24)
	// Bottom-up rows, BGR, each row padded to 4 bytes.
	row := []byte{0, 0, 255, 0, 255, 0, 0, 0} // red, green, padding
	dib = append(dib, row...)
	dib = append(dib, row...)

	out, err := dibToPNG(dib)
	if err != nil {
		t.Fatalf("dibToPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("result is not a PNG: %v", err)
	}
	r, g, b, _ := img.At(0, 0).RGBA()
	if r>>8 != 255 || g>>8 != 0 || b>>8 != 0 {
		t.Fatalf("pixel (0,0) = %d,%d,%d; want red", r>>8, g>>8, b>>8)
	}
}

func TestDIBToPNG_RejectsTruncatedHeader(t *testing.T) {
	if _, err := dibToPNG([]byte{1, 2, 3}); err == nil {
		t.Fatal("expected an error for a truncated DIB")
	}
}

// TestImageClipboard_DIBToBMPConversion verifies DIB to BMP byte reconstruction
func TestImageClipboard_DIBToBMPConversion(t *testing.T) {
	// Construct a synthetic minimal 2x2 24-bit uncompressed RGB DIB
	// BITMAPINFOHEADER is 40 bytes:
	// biSize: 40
	// biWidth: 2
	// biHeight: 2
	// biPlanes: 1
	// biBitCount: 24
	// biCompression: 0 (BI_RGB)
	// biSizeImage: 16 (each row is 2*3=6 bytes, padded to 4-byte boundary = 8 bytes * 2 rows = 16 bytes)
	dib := make([]byte, 40+16)
	binary.LittleEndian.PutUint32(dib[0:4], 40)   // biSize
	binary.LittleEndian.PutUint32(dib[4:8], 2)    // biWidth
	binary.LittleEndian.PutUint32(dib[8:12], 2)   // biHeight
	binary.LittleEndian.PutUint16(dib[12:14], 1)  // biPlanes
	binary.LittleEndian.PutUint16(dib[14:16], 24) // biBitCount
	binary.LittleEndian.PutUint32(dib[16:20], 0)  // biCompression (BI_RGB)
	binary.LittleEndian.PutUint32(dib[20:24], 16) // biSizeImage

	bmp, err := dibToBmp(dib)
	if err != nil {
		t.Fatalf("dibToBmp failed: %v", err)
	}

	if len(bmp) != 14+len(dib) {
		t.Errorf("Expected BMP length %d, got %d", 14+len(dib), len(bmp))
	}
	if bmp[0] != 'B' || bmp[1] != 'M' {
		t.Errorf("Expected BM magic bytes, got %c%c", bmp[0], bmp[1])
	}
	offset := binary.LittleEndian.Uint32(bmp[10:14])
	if offset != 54 { // 14 + 40
		t.Errorf("Expected offset 54, got %d", offset)
	}
}
