// kia-vision — tiny stateless CLI used by the deep-extraction pipeline.
//   kia-vision ocr <imagePath>
//     -> {"text": "...", "width": W, "height": H, "confidence": 0.93}
//   kia-vision rasterize <pdfPath> <outDir> [--pages 3,17,41 | --max-pages N] [--scale S]
//     -> {"pages": ["<outDir>/page-003.png", ...], "pageNumbers": [3, ...], "pageCount": total}
//   Requested pages are deduped and rendered ascending; out-of-range numbers
//   are skipped. --max-pages N is an alias for --pages 1..N.
// Errors: one line on stderr, non-zero exit. No network, no state.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else {
    fail("cannot encode JSON output")
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func runOcr(imagePath: String) {
  let url = URL(fileURLWithPath: imagePath)
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
    let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
  else {
    fail("cannot read image: \(imagePath)")
  }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = true
  }
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  do {
    try handler.perform([request])
  } catch {
    fail("ocr failed: \(error.localizedDescription)")
  }
  var lines: [String] = []
  var confidenceSum = 0.0
  for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    lines.append(top.string)
    confidenceSum += Double(top.confidence)
  }
  emit([
    "text": lines.joined(separator: "\n"),
    "width": img.width,
    "height": img.height,
    "confidence": lines.isEmpty ? 0.0 : confidenceSum / Double(lines.count),
  ])
}

func runRasterize(pdfPath: String, outDir: String, pages wanted: [Int], scale: CGFloat) {
  let url = URL(fileURLWithPath: pdfPath)
  guard let doc = CGPDFDocument(url as CFURL) else {
    fail("cannot read pdf: \(pdfPath)")
  }
  let total = doc.numberOfPages
  do {
    try FileManager.default.createDirectory(
      atPath: outDir, withIntermediateDirectories: true)
  } catch {
    fail("cannot create outDir: \(error.localizedDescription)")
  }
  var pages: [String] = []
  var numbers: [Int] = []
  for i in Set(wanted).filter({ $0 >= 1 && $0 <= total }).sorted() {
    guard let page = doc.page(at: i) else { continue }
    let box = page.getBoxRect(.mediaBox)
    guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0
    else {
      fail("invalid mediaBox for page \(i)")
    }
    // Honor /Rotate: a 90/270-rotated page swaps output width/height.
    let rotated = page.rotationAngle % 180 != 0
    let boxW = rotated ? box.height : box.width
    let boxH = rotated ? box.width : box.height
    // Cap the longest side at 8192px by lowering the effective scale so
    // huge-but-legal pages still render instead of trapping or OOMing.
    var effScale = scale
    let maxSide: CGFloat = 8192
    if max(boxW, boxH) * effScale > maxSide {
      effScale = maxSide / max(boxW, boxH)
    }
    let w = max(1, Int(boxW * effScale))
    let h = max(1, Int(boxH * effScale))
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
      fail("cannot create render context for page \(i)")
    }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
    ctx.scaleBy(x: effScale, y: effScale)
    // Maps the (possibly /Rotate-d) mediaBox onto the context upright.
    ctx.concatenate(
      page.getDrawingTransform(
        .mediaBox, rect: CGRect(x: 0, y: 0, width: boxW, height: boxH),
        rotate: 0, preserveAspectRatio: true))
    ctx.drawPDFPage(page)
    guard let img = ctx.makeImage() else { fail("render failed for page \(i)") }
    let out = (outDir as NSString)
      .appendingPathComponent(String(format: "page-%03d.png", i))
    guard
      let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString,
        1, nil)
    else {
      fail("cannot create png at \(out)")
    }
    CGImageDestinationAddImage(dest, img, nil)
    if !CGImageDestinationFinalize(dest) { fail("png write failed for page \(i)") }
    pages.append(out)
    numbers.append(i)
  }
  emit(["pages": pages, "pageNumbers": numbers, "pageCount": total])
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  fail("usage: kia-vision ocr <image> | rasterize <pdf> <outDir> [--pages 3,17,41 | --max-pages N] [--scale S]")
}
switch args[1] {
case "ocr":
  guard args.count == 3 else { fail("usage: kia-vision ocr <image>") }
  runOcr(imagePath: args[2])
case "rasterize":
  guard args.count >= 4 else {
    fail("usage: kia-vision rasterize <pdf> <outDir> [--pages 3,17,41 | --max-pages N] [--scale S]")
  }
  var pages = Array(1...20)
  var scale: CGFloat = 2.0
  var i = 4
  while i + 1 < args.count {
    if args[i] == "--pages" {
      let parsed = args[i + 1].split(separator: ",").map { Int($0.trimmingCharacters(in: .whitespaces)) }
      guard !parsed.contains(where: { $0 == nil }) else { fail("invalid --pages") }
      pages = parsed.compactMap { $0 }
      i += 2
    } else if args[i] == "--max-pages", let v = Int(args[i + 1]) {
      pages = v > 0 ? Array(1...v) : []
      i += 2
    } else if args[i] == "--scale", let v = Double(args[i + 1]) {
      guard v.isFinite, v > 0 else { fail("invalid --scale") }
      scale = CGFloat(v)
      i += 2
    } else {
      i += 1
    }
  }
  runRasterize(pdfPath: args[2], outDir: args[3], pages: pages, scale: scale)
default:
  fail("unknown subcommand: \(args[1])")
}
