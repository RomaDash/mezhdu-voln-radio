# Working plan

Build the agreed playable receiver with future recording slots. Root owns index.html, styles.css, app.js, integration and publication. Audio helper owns audio-engine.js and its tests. Station helper owns stations.js and its tests. Cursor helper reviews UX independently, with no file writes.

1. Create responsive radio UI, keyboard/touch tuning, power and listening controls.
2. Integrate audio reception and three labelled demonstration signals in the host view.
3. Add host editing, local file attachment and IndexedDB persistence, plus player mode without spoilers.
4. Verify unit behavior and desktop/mobile use in one batched pass; fix observed defects together and confirm once.
5. Publish the verified static output through Sites and open the result.

Review focus: rapid tuning audio races, power off, invalid/duplicate frequencies, persisted Blob files, storage errors, empty station list, player spoilers, drawer focus, mobile overflow.
