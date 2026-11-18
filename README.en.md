# Cutting edge

A Windows x64 multitrack video editor with English and Polish interfaces, local speech recognition and an integrated ChatGPT editing panel.

[Download the Windows installer](https://github.com/szymongazinski/Cutting-edge/releases/latest/download/Cutting-edge-Setup-x64.exe) · [Releases](https://github.com/szymongazinski/Cutting-edge/releases) · [Polska instrukcja](README.md)

## Install and update

Choose your language, project folder and export folder during setup. The defaults are Documents → Cutting edge → Projects and Videos → Cutting edge. Launch **Cutting edge** from Windows Start. To install the latest stable release from PowerShell, run the following command.

~~~powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/szymongazinski/Cutting-edge/v1.0.0/scripts/install.ps1'))) -Language en
~~~

Add `-Interactive` for the setup wizard, or use `-ProjectDir` and `-OutputDir` to supply the paths. Use **Settings → Check for updates** for subsequent versions.

## Edit a project

Open the project menu in the top bar to create or open a project. Drop files in the media library, then drag them onto tracks. Drag either end of a clip to trim its source. Use Ctrl + mouse wheel to zoom around the pointer. **M** toggles timeline snapping. **G** toggles snapping to the scene center, edges and other layers.

Put screen and camera recordings on separate tracks, align them by ear or waveform, then Ctrl-click both clips. **Sync and create compound clip** accepts precise offsets. Double-click a compound to edit its contents. **Remove silence** analyzes a whole source, a trimmed clip or a synchronized compound. Defaults are −35 dB and 0.40 s. Review the detected intervals before ripple removal.

Use the inspector for position, crop, gain and mute. The export dialog supports MP4, MOV, MKV and WebM, custom dimensions, frame rate and quality. Configure defaults in Settings. The preview sits above the timeline in landscape projects and on the full-height right side in portrait projects. Drag the divider to resize it.

Project files autosave and reference original media. When moving to another machine, copy your footage with the .cutproj file and relink missing sources through the inspector.

## Reuse media and layouts

**Media → Global**, **Audio**, **Effects** and **Stickers** are available in every project. Import assets from inside the editor or open the library folder, copy files and refresh. The shared directory is `%LOCALAPPDATA%\Cutting edge\Library`, also accessible beside the executable in a standard installation. A subfolder under sticker represents one family. Its files appear as selectable variants. The included pack has 10 families in 4 colors each. Sticker and visual-effect footage loops when extended. Ordinary video reaches its source end.

Create a template from your scene or define your own media, title and caption slots. Assign new footage and choose the crop for an oversized or differently shaped source. Select a saved caption slot when generating subtitles.

## Captions and ChatGPT

**Captions → Generate captions** transcribes the entire film or a chosen clip with the local ListenActive runtime. Select the language, model, caption box and one of four styles. Captions wrap into shorter timed phrases with one fitted font size. The editor saves an SRT or WebVTT file and adds an editable caption clip. The inspector lets you edit timing, content and typography. Styling appears in the preview and rendered video. **Add text** creates a separate title layer.

ListenActive shares its local model cache with Cutting edge. A first run can download approximately 1.4 GB for the runtime plus the chosen model weights. The available choices are large-v3, large-v3-turbo and small, with NVIDIA GPU acceleration and CPU support.

The **ChatGPT** tab uses the signed-in Codex client and an internet connection. Send a request to modify clips, create titles, generate animated stickers or sound effects, import an HTTPS link or find media on Wikimedia Commons. One undo reverses the timeline edits from a single reply. Source recordings stay on the machine. The assistant receives conversation text and project metadata.

## Build

Use Windows x64, Node.js 24 and Inno Setup 6. Run `npm ci`, `npm run prepare:media` and `npm start`. Run `npm test` for the component suite and `npm run test:ui` for a desktop export workflow. Run `npm run pack` followed by `npm run dist` to build the installer and checksum manifest.

[Application license](LICENSE) · [Third-party notices](THIRD-PARTY.md)
