//! Fetches a subtitle file and hands the player WebVTT, the only format a
//! text track accepts.
//!
//! Subtitles come in every encoding there is — many are Windows-1252 or
//! Latin-1, not UTF-8 — and some hosts send them gzipped. The old converter
//! read everything as UTF-8, which turned accents into `�`.

use std::io::Read;
use std::time::Duration;

use anyhow::bail;

use crate::util;

pub async fn fetch_vtt(url: &str) -> anyhow::Result<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("bad subtitle url");
    }
    let res = util::http().get(url).timeout(Duration::from_secs(20)).send().await?;
    if !res.status().is_success() {
        bail!("{} for the subtitles", res.status());
    }
    let bytes = res.bytes().await?;
    Ok(srt_to_vtt(&decode(&bytes)))
}

/// Bytes to text: gunzipped when needed, then decoded by BOM, as UTF-8 when
/// it is valid, else by a statistical guess at the legacy encoding.
pub fn decode(bytes: &[u8]) -> String {
    let mut owned;
    let mut data = bytes;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        owned = Vec::new();
        if flate2::read::GzDecoder::new(bytes).read_to_end(&mut owned).is_ok() {
            data = &owned;
        }
    }
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(data) {
        return enc.decode_without_bom_handling(&data[bom_len..]).0.into_owned();
    }
    if let Ok(s) = std::str::from_utf8(data) {
        return s.to_string();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(data, true);
    let enc = detector.guess(None, true);
    enc.decode_without_bom_handling(data).0.into_owned()
}

fn fix_timestamp(ts: &str) -> String {
    // 0:01:02,5 / 00:01:02,500 / 01:02.500 → 00:01:02.500
    let ts = ts.trim().replace(',', ".");
    let (clock, frac) = ts.split_once('.').unwrap_or((&ts, "0"));
    let parts: Vec<&str> = clock.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m, s] => (*h, *m, *s),
        [m, s] => ("0", *m, *s),
        _ => return ts.to_string(),
    };
    let num = |x: &str| x.trim().parse::<u32>().unwrap_or(0);
    let mut ms: String = frac.chars().filter(char::is_ascii_digit).take(3).collect();
    while ms.len() < 3 {
        ms.push('0');
    }
    format!("{:02}:{:02}:{:02}.{ms}", num(h), num(m), num(s))
}

/// SubRip to WebVTT: cue numbers dropped, timestamps normalised.
pub fn srt_to_vtt(body: &str) -> String {
    let body = body.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    if body.trim_start().starts_with("WEBVTT") {
        return body;
    }
    let lines: Vec<&str> = body.lines().collect();
    let mut out = String::with_capacity(body.len() + 16);
    out.push_str("WEBVTT\n\n");
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end();
        let next_is_time = lines.get(i + 1).is_some_and(|l| l.contains("-->"));
        if !line.is_empty() && line.trim().chars().all(|c| c.is_ascii_digit()) && next_is_time {
            i += 1; // a cue number
            continue;
        }
        if let Some((a, b)) = line.split_once("-->") {
            // Anything after the end time (SRT position hints) is not valid VTT.
            let end = b.split_whitespace().next().unwrap_or("");
            out.push_str(&format!("{} --> {}\n", fix_timestamp(a), fix_timestamp(end)));
        } else {
            out.push_str(line);
            out.push('\n');
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_srt() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,500 X1:0\r\nHello\r\n\r\n2\r\n0:00:03,5 --> 0:00:04,000\r\nWorld\r\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.500\nHello"));
        assert!(vtt.contains("00:00:03.500 --> 00:00:04.000\nWorld"));
        assert!(!vtt.contains("\n1\n"));
    }

    #[test]
    fn decodes_latin1() {
        let bytes = b"1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9 cr\xe8me br\xfbl\xe9e d\xe9j\xe0 vu\n";
        assert!(decode(bytes).contains("Café crème brûlée déjà vu"));
    }

    #[test]
    fn keeps_vtt() {
        assert_eq!(srt_to_vtt("WEBVTT\n\n00:01.000 --> 00:02.000\nA\n"), "WEBVTT\n\n00:01.000 --> 00:02.000\nA\n");
    }
}
