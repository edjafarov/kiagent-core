// windows-ocr — native Windows OCR helper (Windows.Media.Ocr).
//   windows-ocr ocr <imagePath>
//     -> {"text":"...","width":W,"height":H,"confidence":C}  (stdout, exit 0)
//   windows-ocr selftest
//     -> {"ok":true|false}  (exit 0 if an OCR engine is available, else 1)
// Errors go to stderr with a non-zero exit. Mirrors native/vision-helper/main.swift.
using System;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "selftest")
            {
                var probe = OcrEngine.TryCreateFromUserProfileLanguages();
                Emit(new { ok = probe != null });
                return probe != null ? 0 : 1;
            }

            if (args.Length != 2 || args[0] != "ocr")
            {
                Console.Error.WriteLine(
                    "usage: windows-ocr ocr <imagePath> | windows-ocr selftest");
                return 2;
            }

            var file = await StorageFile.GetFileFromPathAsync(args[1]);
            using var stream = await file.OpenAsync(FileAccessMode.Read);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            int width = (int)decoder.PixelWidth;
            int height = (int)decoder.PixelHeight;

            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null)
            {
                Console.Error.WriteLine(
                    "no OCR engine for the user profile languages");
                return 1;
            }

            // Windows.Media.Ocr caps the input dimension; oversize → empty text
            // (best-effort, like the macOS helper — description still runs).
            if (width > OcrEngine.MaxImageDimension || height > OcrEngine.MaxImageDimension)
            {
                Emit(new { text = "", width, height, confidence = 0.0 });
                return 0;
            }

            using var raw = await decoder.GetSoftwareBitmapAsync();
            using var bitmap = SoftwareBitmap.Convert(
                raw, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var result = await engine.RecognizeAsync(bitmap);

            // Windows.Media.Ocr exposes no per-line/word confidence; the field is
            // informational (the extractor gates on text length, not confidence).
            var text = string.Join("\n", result.Lines.Select(l => l.Text));
            Emit(new { text, width, height, confidence = text.Length > 0 ? 1.0 : 0.0 });
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    private static void Emit(object value)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine(JsonSerializer.Serialize(value));
    }
}
