---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

Add TPDF dithering to audio quantization

Apply Triangular Probability Density Function (TPDF) dithering when quantizing Float32 samples to integer formats. This decorrelates quantization error from the signal, converting audible harmonic distortion into inaudible white noise floor.

**Changes**

- Add `tpdfDither()` utility function to protocol package
- Apply dithering in PCM encoder (Float32 → Int16)
- Apply dithering in FLAC encoder 24-bit path (Float32 → Int24)

Improves audio quality especially in quiet passages, fade-outs, and music with wide dynamic range.
