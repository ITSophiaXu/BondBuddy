#!/bin/sh
set -eu

fail() { echo "worker OCR runtime unavailable: $*" >&2; exit 1; }
data_dir=/usr/share/tesseract-ocr/5/tessdata
[ "${TESSDATA_PREFIX:-}" = "$data_dir" ] || fail 'unexpected TESSDATA_PREFIX'
[ "$(command -v tesseract)" = /usr/bin/tesseract ] || fail 'unexpected tesseract executable'
[ -x /usr/bin/tesseract ] || fail 'missing tesseract executable'

for spec in tesseract-ocr=5.3.0-2 tesseract-ocr-eng=1:4.1.0-2 \
    tesseract-ocr-chi-sim=1:4.1.0-2 tesseract-ocr-osd=1:4.1.0-2; do
  package=${spec%%=*}
  version=${spec#*=}
  installed=$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null) ||
    fail "missing $package"
  [ "$installed" = "$version" ] || fail "unexpected $package version"
done

case "$(dpkg --print-architecture)" in
  amd64) engine_hash=1e8c7ce7f27d2d1c902fb648efed443483f2a8fc7b60c48a5d3b61d647a2649e ;;
  arm64) engine_hash=efbb3e85b26a370ad303539dd357fc1ead69f987de117e5bb8a95b422e8e21ee ;;
  *) fail 'unsupported tesseract architecture' ;;
esac
printf '%s  /usr/bin/tesseract\n' "$engine_hash" |
  sha256sum -c --status - || fail 'engine SHA-256 mismatch'
version=$(/usr/bin/tesseract --version 2>&1) || fail 'engine version probe failed'
[ "$(printf '%s\n' "$version" | sed -n '1p')" = 'tesseract 5.3.0' ] ||
  fail 'unexpected engine version'
languages=$(/usr/bin/tesseract --list-langs 2>&1) || fail 'language probe failed'
reported_dir=$(printf '%s\n' "$languages" |
  sed -n '1s/^List of available languages in "\(.*\)" ([0-9][0-9]*):$/\1/p')
[ "${reported_dir%/}" = "$data_dir" ] || fail 'engine is reading unexpected language data'
for lang in eng chi_sim osd; do
  printf '%s\n' "$languages" | grep -Fxq "$lang" || fail "missing $lang"
done

printf '%s\n' \
  "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  $data_dir/eng.traineddata" \
  "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730  $data_dir/chi_sim.traineddata" \
  "9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff  $data_dir/osd.traineddata" |
  sha256sum -c --status - || fail 'language data SHA-256 mismatch'
echo 'worker OCR runtime verified: tesseract 5.3.0, eng+chi_sim+osd'
