package neoread

import (
	"bufio"
	"encoding/binary"
	"errors"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"

	"golang.org/x/image/riff"
	_ "golang.org/x/image/webp"
)

const (
	maxNoteImageBytes  = 10 << 20
	maxNoteImageAxis   = 8192
	maxNoteImagePixels = 16 << 20
	maxNoteImageFrames = 256
)

var (
	errNoteImageFormat = errors.New("unsupported image format")
	errNoteImageData   = errors.New("invalid image data")
	errNoteImageBounds = errors.New("image exceeds dimension or frame budget")
	errNoteImageMotion = errors.New("unsupported image animation")
)

func noteImageContentType(ext string) string {
	switch ext {
	case "png", "gif", "webp":
		return "image/" + ext
	case "jpg":
		return "image/jpeg"
	default:
		return ""
	}
}

func noteImageDimensionsOK(width, height int) bool {
	return width > 0 && height > 0 && width <= maxNoteImageAxis && height <= maxNoteImageAxis && width*height <= maxNoteImagePixels
}

func validateNoteImage(source io.ReaderAt, size int64) (string, error) {
	var header [16]byte
	n, err := source.ReadAt(header[:], 0)
	if n == 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return "", errNoteImageData
	}
	var ext string
	switch http.DetectContentType(header[:n]) {
	case "image/png":
		ext = "png"
	case "image/jpeg":
		ext = "jpg"
	case "image/gif":
		ext = "gif"
	case "image/webp":
		ext = "webp"
	default:
		return "", errNoteImageFormat
	}
	r := io.NewSectionReader(source, 0, size)
	cfg, _, err := image.DecodeConfig(r)
	if err != nil {
		return "", errNoteImageData
	}
	if !noteImageDimensionsOK(cfg.Width, cfg.Height) {
		return "", errNoteImageBounds
	}
	_, _ = r.Seek(0, io.SeekStart)
	switch ext {
	case "png":
		err = checkNotePNGChunks(r)
	case "gif":
		err = checkNoteGIFBudget(r)
	case "webp":
		err = checkNoteWebPChunks(r)
	}
	if err != nil {
		return "", err
	}
	_, _ = r.Seek(0, io.SeekStart)
	if ext == "gif" {
		_, err = gif.DecodeAll(r)
	} else {
		_, _, err = image.Decode(r)
	}
	if err != nil {
		return "", errNoteImageData
	}
	return ext, nil
}

// Go's PNG decoder ignores the additional frames in an APNG. Do not serve
// frame data that we have not validated.
func checkNotePNGChunks(r *io.SectionReader) error {
	_, _ = r.Seek(8, io.SeekStart)
	var chunk [8]byte
	for {
		if _, err := io.ReadFull(r, chunk[:]); err != nil {
			return errNoteImageData
		}
		switch string(chunk[4:]) {
		case "acTL", "fcTL", "fdAT":
			return errNoteImageMotion
		case "IEND":
			return nil
		}
		if _, err := r.Seek(int64(binary.BigEndian.Uint32(chunk[:4]))+4, io.SeekCurrent); err != nil {
			return errNoteImageData
		}
	}
}

// Scan frame headers before DecodeAll, which keeps every decoded frame.
func checkNoteGIFBudget(r io.Reader) error {
	b := bufio.NewReader(r)
	var block [13]byte
	if _, err := io.ReadFull(b, block[:]); err != nil {
		return errNoteImageData
	}
	if block[10]&0x80 != 0 {
		if _, err := b.Discard(3 << (1 + (block[10] & 7))); err != nil {
			return errNoteImageData
		}
	}
	frames, pixels := 0, 0
	for {
		kind, err := b.ReadByte()
		if err != nil {
			return errNoteImageData
		}
		switch kind {
		case 0x3b: // Trailer.
			return nil
		case 0x21: // Extension label, then data sub-blocks.
			if _, err := b.ReadByte(); err != nil {
				return errNoteImageData
			}
		case 0x2c: // Frame descriptor, optional palette, then LZW data.
			if _, err := io.ReadFull(b, block[:9]); err != nil {
				return errNoteImageData
			}
			width := int(binary.LittleEndian.Uint16(block[4:6]))
			height := int(binary.LittleEndian.Uint16(block[6:8]))
			if !noteImageDimensionsOK(width, height) {
				return errNoteImageBounds
			}
			frames++
			pixels += width * height
			if frames > maxNoteImageFrames || pixels > maxNoteImagePixels {
				return errNoteImageBounds
			}
			if block[8]&0x80 != 0 {
				if _, err := b.Discard(3 << (1 + (block[8] & 7))); err != nil {
					return errNoteImageData
				}
			}
			if _, err := b.ReadByte(); err != nil {
				return errNoteImageData
			}
		default:
			return errNoteImageData
		}
		for {
			size, err := b.ReadByte()
			if err != nil {
				return errNoteImageData
			}
			if size == 0 {
				break
			}
			if _, err := b.Discard(int(size)); err != nil {
				return errNoteImageData
			}
		}
	}
}

// The WebP decoder returns one frame. Reject animation and extra frame chunks.
func checkNoteWebPChunks(r io.Reader) error {
	_, chunks, err := riff.NewReader(r)
	if err != nil {
		return errNoteImageData
	}
	var frame, extended bool
	for {
		kind, size, data, err := chunks.Next()
		if errors.Is(err, io.EOF) && frame {
			return nil
		}
		if err != nil {
			return errNoteImageData
		}
		switch string(kind[:]) {
		case "ANIM", "ANMF":
			return errNoteImageMotion
		case "VP8X":
			var header [10]byte
			if extended || frame || size != uint32(len(header)) {
				return errNoteImageData
			}
			if _, err := io.ReadFull(data, header[:]); err != nil {
				return errNoteImageData
			}
			if header[0]&2 != 0 {
				return errNoteImageMotion
			}
			extended = true
		case "VP8 ", "VP8L":
			if frame {
				return errNoteImageData
			}
			frame = true
		}
	}
}
