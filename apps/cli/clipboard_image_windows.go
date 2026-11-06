//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image/png"
	"syscall"
	"unsafe"

	"golang.org/x/image/bmp"
)

// Windows implementation: reads CF_DIB from Win32 clipboard API and encodes as PNG
func readOSClipboardImage() ([]byte, error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	kernel32 := syscall.NewLazyDLL("kernel32.dll")

	openClipboard := user32.NewProc("OpenClipboard")
	closeClipboard := user32.NewProc("CloseClipboard")
	getClipboardData := user32.NewProc("GetClipboardData")
	isClipboardFormatAvailable := user32.NewProc("IsClipboardFormatAvailable")

	globalLock := kernel32.NewProc("GlobalLock")
	globalUnlock := kernel32.NewProc("GlobalUnlock")
	globalSize := kernel32.NewProc("GlobalSize")

	const CF_DIB = 8

	available, _, _ := isClipboardFormatAvailable.Call(CF_DIB)
	if available == 0 {
		return nil, nil // No image on clipboard
	}

	r, _, _ := openClipboard.Call(0)
	if r == 0 {
		return nil, fmt.Errorf("failed to open clipboard")
	}
	defer closeClipboard.Call()

	hData, _, _ := getClipboardData.Call(CF_DIB)
	if hData == 0 {
		return nil, nil
	}

	ptr, _, _ := globalLock.Call(hData)
	if ptr == 0 {
		return nil, fmt.Errorf("GlobalLock failed")
	}
	defer globalUnlock.Call(hData)

	size, _, _ := globalSize.Call(hData)
	if size == 0 {
		return nil, nil
	}

	if size > maxClipboardImageBytes*4 { // raw DIBs are uncompressed; refuse absurd sizes
		return nil, fmt.Errorf("clipboard image too large (%d bytes)", size)
	}

	// ptr is a pointer into the locked global memory block, valid until GlobalUnlock.
	// Re-interpreting the uintptr slot avoids a uintptr->Pointer conversion.
	locked := unsafe.Slice((*byte)(*(*unsafe.Pointer)(unsafe.Pointer(&ptr))), int(size))
	dibData := make([]byte, len(locked))
	copy(dibData, locked)

	return dibToPNG(dibData)
}

// dibToPNG converts a Windows device-independent bitmap to PNG bytes.
func dibToPNG(dib []byte) ([]byte, error) {
	// Convert DIB to BMP byte stream by prepending BITMAPFILEHEADER
	bmpBytes, err := dibToBmp(dib)
	if err != nil {
		return nil, err
	}

	img, err := bmp.Decode(bytes.NewReader(bmpBytes))
	if err != nil {
		return nil, fmt.Errorf("decode bmp error: %w", err)
	}

	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		return nil, fmt.Errorf("encode png error: %w", err)
	}
	return pngBuf.Bytes(), nil
}

// Prepends 14-byte BITMAPFILEHEADER to raw DIB data to form a valid BMP
func dibToBmp(dib []byte) ([]byte, error) {
	if len(dib) < 40 {
		return nil, fmt.Errorf("invalid DIB header length")
	}

	headerSize := binary.LittleEndian.Uint32(dib[0:4])
	bitCount := binary.LittleEndian.Uint16(dib[14:16])
	compression := binary.LittleEndian.Uint32(dib[16:20])

	var paletteColors uint32
	if headerSize >= 36 {
		paletteColors = binary.LittleEndian.Uint32(dib[32:36])
	}
	if paletteColors == 0 && bitCount <= 8 {
		paletteColors = 1 << bitCount
	}

	var paletteSize uint32 = paletteColors * 4
	if compression == 3 && headerSize == 40 { // BI_BITFIELDS
		paletteSize += 12
	}

	offset := 14 + headerSize + paletteSize
	fileSize := 14 + uint32(len(dib))

	bmp := make([]byte, 14+len(dib))
	bmp[0] = 'B'
	bmp[1] = 'M'
	binary.LittleEndian.PutUint32(bmp[2:6], fileSize)
	binary.LittleEndian.PutUint32(bmp[6:10], 0) // Reserved
	binary.LittleEndian.PutUint32(bmp[10:14], offset)

	copy(bmp[14:], dib)
	return bmp, nil
}
