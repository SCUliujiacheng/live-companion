# Synthetic Mandarin ASR fixture

`chinese-speech.wav` is a 5.2-second excerpt of a publicly distributed synthetic
voice sample, not a user recording or a live room. It speaks:

> Kokoro 是一系列体积虽小但功能强大的 TTS 模型。

## Provenance and license

- Author/publisher: hexgrad, Kokoro project.
- Source: [Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh).
- Revision: `01e7505bd6a7a2ac4975463114c3a7650a9f7218`.
- [Original synthetic WAV](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/resolve/01e7505bd6a7a2ac4975463114c3a7650a9f7218/samples/HEARME_zf_001.wav).
- [Original generation script and text](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/01e7505bd6a7a2ac4975463114c3a7650a9f7218/samples/make_zh.py).
- License: Apache-2.0, as declared by the source repository. The full license is
  retained beside the fixture as `chinese-speech.LICENSE`. This audio is not
  relicensed under the application's MIT license.
- Changes: truncated to the first 5.2 seconds and converted from 24 kHz to 16 kHz
  PCM16 mono. No other content was added.
- Original full WAV SHA-256:
  `6c8685f06fd809ca2e892f8b71f3549d0640ab992b37648781f9138be33ef035`.
- Checked-in excerpt SHA-256:
  `378fb398ce22ee7afc69cb8a2e1773ad05d1cf4f8077671072216c9b2c7b0890`.

Reproduce the conversion after downloading the pinned original above:

```sh
ffmpeg -i HEARME_zf_001.wav -t 5.2 -ar 16000 -ac 1 -c:a pcm_s16le chinese-speech.wav
```

The checked-in WAV makes the real Whisper smoke reproducible on Windows and
Linux without Windows SAPI, an installed Chinese voice, credentials, a TTS cloud
service, a microphone, or personal recordings. A single synthetic sentence is a
loading/inference regression check, not an ASR accuracy benchmark. Assertions
check meaningful Chinese content (`功能`, `强大`/`強大`, `模型`) rather than an
exact spelling of the model's English name.
