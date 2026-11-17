import io
import struct
import unittest
import zlib
from PIL import Image, ImageDraw

from bondbuddy_file_authoring.bounded_image import ImageFailure, MAX_OUTPUT_BYTES, preview


def encoded(image, format="PNG", **options):
    out = io.BytesIO()
    image.save(out, format=format, **options)
    return out.getvalue()


class BoundedImageTests(unittest.TestCase):
    def test_scanned_table_preview_is_bounded_and_original_unchanged(self):
        image = Image.new("RGB", (2400, 3400), "white")
        draw = ImageDraw.Draw(image)
        for y in range(100, 3300, 55):
            draw.text((100, y), "Financial line: 123,456.78 / 90,123.45 / 12,300.00", fill="black")
            draw.line((100, y + 35, 2300, y + 35), fill="black", width=2)
        data = encoded(image)
        result = preview(data)
        self.assertLessEqual(result["byte_size"], MAX_OUTPUT_BYTES)
        self.assertLessEqual(max(result["preview_width"], result["preview_height"]), 1600)
        self.assertEqual(result["region"], [0, 0, 2400, 3400])
        self.assertTrue(result["scaled"])
        self.assertEqual(data, encoded(image))
        self.assertIn("not a full-resolution read", result["note"])

    def test_crop_keeps_small_financial_text_at_native_resolution(self):
        image = Image.new("RGB", (2400, 3400), "white")
        ImageDraw.Draw(image).text((1020, 1510), "123,456.78", fill="black")
        result = preview(encoded(image), [1000, 1500, 400, 200])
        self.assertEqual((result["preview_width"], result["preview_height"]), (400, 200))
        self.assertEqual(result["region"], [1000, 1500, 400, 200])
        self.assertFalse(result["scaled"])
        self.assertGreaterEqual(result["jpeg_quality"], 80)

    def test_high_entropy_image_requires_smaller_crop_instead_of_bad_quality(self):
        image = Image.effect_noise((1600, 1600), 100).convert("RGB")
        data = encoded(image)
        with self.assertRaisesRegex(ImageFailure, "IMAGE_REGION_TOO_COMPLEX_USE_SMALLER_CROP"):
            preview(data)
        result = preview(data, [100, 100, 256, 256])
        self.assertLessEqual(result["byte_size"], MAX_OUTPUT_BYTES)
        self.assertFalse(result["scaled"])

    def test_rejects_bad_crop_oversize_header_invalid_file_and_multiframe(self):
        data = encoded(Image.new("RGB", (20, 30)))
        for crop in ([0, 0, 0, 5], [-1, 0, 10, 10], [0, 0, 21, 30], [0, 0, True, 5]):
            with self.subTest(crop=crop), self.assertRaisesRegex(ImageFailure, "IMAGE_CROP_INVALID"):
                preview(data, crop)
        with self.assertRaisesRegex(ImageFailure, "IMAGE_DECODE_FAILED"):
            preview(b"not an image")
        huge = bytearray(data)
        huge[16:24] = struct.pack(">II", 100000, 100000)
        huge[29:33] = struct.pack(">I", zlib.crc32(huge[12:29]))
        with self.assertRaisesRegex(ImageFailure, "IMAGE_PIXEL_LIMIT"):
            preview(bytes(huge))
        frames = encoded(Image.new("RGB", (20, 20), "red"), "GIF", save_all=True,
                         append_images=[Image.new("RGB", (20, 20), "blue")])
        with self.assertRaisesRegex(ImageFailure, "IMAGE_MULTIFRAME_UNSUPPORTED"):
            preview(frames)

    def test_exif_orientation_is_applied_before_crop_coordinates(self):
        image = Image.new("RGB", (60, 30), "white")
        exif = image.getexif()
        exif[274] = 6
        result = preview(encoded(image, "JPEG", exif=exif), [0, 30, 30, 30])
        self.assertEqual((result["source_width"], result["source_height"]), (30, 60))
        self.assertEqual((result["preview_width"], result["preview_height"]), (30, 30))


if __name__ == "__main__":
    unittest.main()
