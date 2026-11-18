# FAST/SAMP

Неофициальное приложение для Windows x64. Открой Samplette, выбери трек и перетащи готовый WAV в Playlist FL Studio.

## Скачать для Windows

[**Скачать FAST-SAMP-windows-x64.zip**](https://github.com/sry4thedlyy/fast-samp/releases/latest/download/FAST-SAMP-windows-x64.zip)

1. Распакуй ZIP и запусти `FAST-SAMP.exe` из папки `FAST-SAMP`.
2. Нажми **Выбрать…** в настройках и укажи папку для WAV.
3. Выбери трек в Samplette или добавь его через **По ссылке**. yt-dlp, FFmpeg и FFprobe уже включены в архив.
4. Перетащи WAV в Playlist FL Studio из панели сэмпла или за строку в **Библиотеке**. Булавка удерживает окно поверх FL Studio.

Кнопка **По ссылке** принимает адрес трека Samplette или видео YouTube. В **Настройках** можно отключить автоматическую подготовку и выбрать папку скачивания. **Папка WAV** открывает текущую папку в Проводнике.

В **Библиотеке** кнопка с корзиной удаляет запись и перемещает WAV в Корзину Windows. Приложение сохраняет полный трек в формате 16-битного стерео PCM WAV. Ранее скачанные файлы доступны по исходным путям.

Для семплирования используй материал, на который у тебя есть разрешение.

## Quick start

Download the [Windows x64 release](https://github.com/sry4thedlyy/fast-samp/releases/latest), extract the entire ZIP, and run `FAST-SAMP.exe`. Choose a folder for your WAV files, then pick a track in Samplette. yt-dlp, FFmpeg and FFprobe are included. When the WAV is ready, drag it into the FL Studio Playlist.

## Сборка из исходников

Требуются Windows x64 и Node.js.

```powershell
npm ci
npm run setup:audio
npm start
```

Для ZIP-архива релиза выполни `npm run package:windows`. Готовый архив появится в `dist/release`. Команда `npm run setup:audio -- --update` обновляет yt-dlp для запуска из исходников.

Сборка содержит аудиоинструменты из [релизов yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) и [Windows-сборок FFmpeg от Gyan Doshi](https://www.gyan.dev/ffmpeg/builds/). Версии, лицензии и ссылки на исходники приведены в [THIRD_PARTY.md](THIRD_PARTY.md).
