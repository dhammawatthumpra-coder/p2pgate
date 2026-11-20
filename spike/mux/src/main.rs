use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead};
use std::time::Instant;

const MAX_FRAME: usize = 16 * 1024;
const HEADER: usize = 10;

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn hex_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = (bytes[i + 1] as char).to_digit(16).unwrap_or(0) as u8;
        out.push((hi << 4) | lo);
        i += 2;
    }
    out
}

fn encode_frame(kind: u8, flags: u8, channel: u32, payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() <= MAX_FRAME, "frame too large");
    let mut frame = Vec::with_capacity(HEADER + payload.len());
    frame.push(kind);
    frame.push(flags);
    frame.extend_from_slice(&channel.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[derive(Serialize, Clone)]
struct Frame {
    #[serde(rename = "type")]
    kind: u8,
    flags: u8,
    #[serde(rename = "channelId")]
    channel_id: u32,
    payload: String,
}

struct Parser {
    pending: Vec<u8>,
    pos: usize,
    frames: Vec<Frame>,
    error: bool,
}

impl Parser {
    fn new() -> Self {
        Self { pending: Vec::new(), pos: 0, frames: Vec::new(), error: false }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);

        loop {
            let avail = self.pending.len() - self.pos;
            if avail < HEADER {
                break;
            }
            let base = self.pos;
            let kind = self.pending[base];
            let flags = self.pending[base + 1];
            let channel = u32::from_be_bytes([
                self.pending[base + 2],
                self.pending[base + 3],
                self.pending[base + 4],
                self.pending[base + 5],
            ]);
            let length = u32::from_be_bytes([
                self.pending[base + 6],
                self.pending[base + 7],
                self.pending[base + 8],
                self.pending[base + 9],
            ]) as usize;

            if length > MAX_FRAME {
                self.error = true;
                break;
            }
            if avail < HEADER + length {
                break;
            }

            let payload = self.pending[base + HEADER..base + HEADER + length].to_vec();
            self.frames.push(Frame {
                kind,
                flags,
                channel_id: channel,
                payload: hex_encode(&payload),
            });
            self.pos = base + HEADER + length;
        }

        if self.pos > 0 {
            self.pending.drain(..self.pos);
            self.pos = 0;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    kind: String,
    #[serde(default)]
    r#type: u8,
    #[serde(default)]
    flags: u8,
    #[serde(default)]
    channel_id: u32,
    #[serde(default)]
    payload: String,
    #[serde(default)]
    chunks: Vec<String>,
    #[serde(default)]
    expected: Option<Value>,
}

fn parity() {
    let stdin = io::stdin();
    let mut total = 0usize;
    let mut mismatches = 0usize;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            _ => continue,
        };
        let case: Case = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("bad case: {e}");
                mismatches += 1;
                continue;
            }
        };
        total += 1;

        match case.kind.as_str() {
            "encode" => {
                let payload = hex_decode(&case.payload);
                let frame = encode_frame(case.r#type, case.flags, case.channel_id, &payload);
                println!("{{\"encoded\":\"{}\"}}", hex_encode(&frame));
            }
            "parse" => {
                let mut parser = Parser::new();
                for chunk in &case.chunks {
                    parser.push(&hex_decode(chunk));
                }
                let actual = serde_json::json!({
                    "frames": parser.frames,
                    "error": parser.error
                });
                if let Some(expected) = &case.expected {
                    // compare fields the JS side records (frames order + error flag)
                    let exp_frames = expected.get("frames").cloned().unwrap_or(Value::Null);
                    let exp_error = expected.get("error").cloned().unwrap_or(Value::Null);
                    let act_frames = actual.get("frames").cloned().unwrap_or(Value::Null);
                    let act_error = actual.get("error").cloned().unwrap_or(Value::Null);
                    if exp_frames != act_frames || exp_error != act_error {
                        mismatches += 1;
                        eprintln!(
                            "mismatch: chunks={} expected_error={} actual_error={}",
                            case.chunks.len(),
                            exp_error,
                            act_error
                        );
                    }
                }
                println!("{}", actual);
            }
            other => eprintln!("unknown case kind: {other}"),
        }
    }

    eprintln!("parity: {} cases, {} mismatches", total, mismatches);
    std::process::exit(if mismatches == 0 { 0 } else { 1 });
}

struct CountParser {
    pending: Vec<u8>,
    pos: usize,
    count: usize,
    bytes: usize,
    error: bool,
}

impl CountParser {
    fn new() -> Self {
        Self { pending: Vec::new(), pos: 0, count: 0, bytes: 0, error: false }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        loop {
            let avail = self.pending.len() - self.pos;
            if avail < HEADER {
                break;
            }
            let base = self.pos;
            let length = u32::from_be_bytes([
                self.pending[base + 6],
                self.pending[base + 7],
                self.pending[base + 8],
                self.pending[base + 9],
            ]) as usize;
            if length > MAX_FRAME {
                self.error = true;
                break;
            }
            if avail < HEADER + length {
                break;
            }
            self.count += 1;
            // Match the JS parser, which detaches each payload (Buffer.from),
            // so the comparison includes the same copy cost.
            let payload = self.pending[base + HEADER..base + HEADER + length].to_vec();
            if !payload.is_empty() {
                self.bytes ^= payload[0] as usize ^ payload[payload.len() - 1] as usize;
            }
            std::hint::black_box(&payload);
            self.pos = base + HEADER + length;
        }
        if self.pos > 0 {
            self.pending.drain(..self.pos);
            self.pos = 0;
        }
    }
}

fn bench(iterations: usize, payload_size: usize) {
    // Pseudo-random payload so the optimizer cannot fold the copy away.
    let mut seed = 0x1234_5678_9abc_def0u64;
    let mut payload = vec![0u8; payload_size];
    for byte in payload.iter_mut() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        *byte = (seed >> 33) as u8;
    }

    let start = Instant::now();
    let mut bytes = 0usize;
    for i in 0..iterations {
        let frame = encode_frame(4, 0, (i & 0xffff) as u32, &payload);
        bytes += frame.len();
        bytes ^= frame[HEADER + (i % payload_size)] as usize;
        std::hint::black_box(&frame);
    }
    let encode_ns = start.elapsed().as_nanos() as f64;

    let per_chunk = 1024usize;
    let mut batch = Vec::with_capacity(per_chunk * (HEADER + payload.len()));
    for i in 0..per_chunk {
        batch.extend_from_slice(&encode_frame(4, 0, i as u32, &payload));
    }
    let rounds = (iterations + per_chunk - 1) / per_chunk;

    // Count frames only: the JS benchmark does not build payload copies or hex
    // strings either, so this is the fair comparison for codec CPU cost.
    let mut parser = CountParser::new();
    let start = Instant::now();
    for _ in 0..rounds {
        parser.push(&batch);
    }
    let parse_ns = start.elapsed().as_nanos() as f64;

    let out = serde_json::json!({
        "runtime": "rust",
        "iterations": iterations,
        "encode": {
            "ms": encode_ns / 1e6,
            "nsPerOp": encode_ns / iterations as f64,
            "bytes": bytes
        },
        "parse": {
            "ms": parse_ns / 1e6,
            "nsPerOp": parse_ns / iterations as f64,
            "produced": parser.count
        }
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("parity");
    match mode {
        "parity" => parity(),
        "bench" => {
            let n = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(500_000);
            let size = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(64);
            bench(n, size);
        }
        other => {
            eprintln!("usage: mux-codec-spike [parity|bench] [iterations] (got {other})");
            std::process::exit(2);
        }
    }
}
