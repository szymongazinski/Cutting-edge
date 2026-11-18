# Silnik multimedialny

## FFmpeg i FFprobe

Program uruchamia FFmpeg i FFprobe jako osobne procesy. Instalator Windows zawiera niezmienione programy x64 z zestawu Gyan FFmpeg 7.1.1 Essentials, zbudowanego z opcjami GPL i version3. Licencja GPL v3 znajduje się w pliku LICENSE obok obu programów. Polecenie ffmpeg.exe -buildconf wyświetla konfigurację dołączonego wydania.

- [Wydanie Gyan 7.1.1 z binariami i identyfikatorem źródeł](https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1)
- [Kod źródłowy tej wersji FFmpeg](https://github.com/FFmpeg/FFmpeg/tree/db69d06eeeab4f46da15030a80d539efb4503ca8)
- [Archiwum źródeł FFmpeg](https://github.com/FFmpeg/FFmpeg/archive/db69d06eeeab4f46da15030a80d539efb4503ca8.tar.gz)
- [Informacje autora kompilacji i lista bibliotek](https://www.gyan.dev/ffmpeg/builds/)

Przygotowanie wydania i testów na Windows odbywa się poleceniem `node scripts/prepare-media.cjs`. Skrypt sprawdza sumy SHA-256 każdego pliku. Korzysta z identycznej kopii w pamięci podręcznej ListenActive, jeśli jest dostępna. W przeciwnym razie pobiera przypięte archiwum producenta o sumie `04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4`. Gotowy katalog tools jest kopiowany do resources/tools w wydaniu Electron.

## Rozpoznawanie mowy

Napisy są rozpoznawane na komputerze użytkownika przez [ListenActive v0.1.1](https://github.com/szymongazinski/ListenActive/releases/tag/v0.1.1). Edytor przekazuje mu lokalny miks PCM mono 16 kHz przez udokumentowany w kodzie parametr `--recognize`. Wynik zawiera czasy początku i końca segmentów. Domyślny model to large-v3. Dla urządzeń z mniejszą pamięcią dostępny jest również small. Po nieudanej próbie akceleracji edytor ponawia rozpoznawanie na CPU z wybranym modelem.

Edytor odnajduje dystrybucję ListenActive obok edytora, w pamięci podręcznej użytkownika, w PATH lub przez skrót ListenActive na pulpicie albo w menu Start. Zmienna środowiskowa `CUTTING_EDGE_LISTENACTIVE` pozwala wskazać bezpośrednio plik ListenActive.exe z kompletnego rozpakowanego wydania. Przy pierwszej transkrypcji na komputerze bez ListenActive edytor pobiera wydanie Windows x64 (około 1,4 GB), weryfikuje SHA-256 i umieszcza je w `%LOCALAPPDATA%\Cutting edge\runtime\ListenActive-v0.1.1`. ListenActive pobiera wybrany model przy pierwszym użyciu i współdzieli go z własną aplikacją w `%LOCALAPPDATA%\ListenActive\models`. Późniejsze transkrypcje z kompletnym modelem działają offline. Kod aplikacji ListenActive jest dostępny na licencji MIT. W jej dystrybucji znajdują się informacje o licencjach zależności i bibliotek NVIDIA.

- [Kod faktycznie używanego procesu rozpoznawania](https://github.com/szymongazinski/ListenActive/blob/v0.1.1/engine.py)
- [Licencje ListenActive i zależności](https://github.com/szymongazinski/ListenActive/blob/v0.1.1/THIRD-PARTY.md)
