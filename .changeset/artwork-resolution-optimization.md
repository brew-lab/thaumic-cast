---
'@thaumic-cast/desktop': minor
'@thaumic-cast/server': minor
---

Add configurable artwork resolution with precedence chain

**New Artwork Module (thaumic-core)**

- Add `ArtworkConfig` and `ArtworkSource` types for flexible artwork configuration
- Support precedence chain: external HTTPS URL > `data_dir/artwork.jpg` > embedded default
- External URL option enables Android Sonos app compatibility (requires HTTPS)
- Single `read()` call with `NotFound` handling avoids TOCTTOU race

**Server Configuration**

- Add `artwork_url` config option and `THAUMIC_ARTWORK_URL` env var
- Document artwork precedence in `config.example.yaml`

**API Changes**

- Replace `AppStateBuilder::artwork(&[u8])` with `artwork_config(ArtworkConfig)`
- Add `AppState::artwork_metadata_url()` for Sonos DIDL-Lite metadata
- Pass artwork URL through `start_playback()` and `start_playback_multi()`

**Desktop App**

- Cache resolved `ArtworkSource` to avoid disk I/O on every playback; URL computed on-demand with current IP/port
- Support custom artwork via `artwork.jpg` in app data directory
