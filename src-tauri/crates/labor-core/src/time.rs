//! UTC timestamps with whole-second precision, stored as `YYYY-MM-DDTHH:MM:SSZ`.
//! Whole seconds keep segment sums exact in every export and in the UI.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Ts(pub i64);

impl Ts {
    /// 0000-01-01T00:00:00Z and 9999-12-31T23:59:59Z: the range `iso` can print and `parse` can read.
    pub const MIN: Self = Self(-62_167_219_200);
    pub const MAX: Self = Self(253_402_300_799);

    #[must_use]
    pub fn secs(self) -> i64 {
        self.0
    }
    #[must_use]
    pub fn datetime(self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0, 0).unwrap_or(DateTime::UNIX_EPOCH)
    }
    #[must_use]
    pub fn iso(self) -> String {
        self.datetime().format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }
    /// Accepts any RFC 3339 value, normalises it to UTC and truncates to whole seconds.
    pub fn parse(s: &str) -> Option<Self> {
        DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| Self(d.timestamp()))
            .filter(|t| (Self::MIN.0..=Self::MAX.0).contains(&t.0))
    }
    #[must_use]
    pub fn later(self, secs: i64) -> Self {
        Self(self.0.saturating_add(secs).min(Self::MAX.0))
    }
}

impl fmt::Display for Ts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.iso())
    }
}

impl Serialize for Ts {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.iso())
    }
}

impl<'de> Deserialize<'de> for Ts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("invalid RFC 3339 timestamp"))
    }
}

/// The only source of time in the application.
pub trait Clock: Send + Sync {
    fn now(&self) -> Ts;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Ts {
        Ts(Utc::now().timestamp())
    }
}

/// Test clock. Clones share one time value.
#[derive(Clone, Debug, Default)]
pub struct ManualClock(Arc<AtomicI64>);

impl ManualClock {
    #[must_use]
    pub fn at(iso: &str) -> Self {
        Self(Arc::new(AtomicI64::new(Ts::parse(iso).map_or(0, Ts::secs))))
    }
    pub fn set(&self, iso: &str) {
        self.0
            .store(Ts::parse(iso).map_or(0, Ts::secs), Ordering::SeqCst);
    }
    pub fn advance(&self, secs: i64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Ts {
        Ts(self.0.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_as_utc_z() {
        let t = Ts::parse("2026-03-08T07:00:00.750-04:00").unwrap();
        assert_eq!(t.iso(), "2026-03-08T11:00:00Z");
        let j = serde_json::to_string(&t).unwrap();
        assert_eq!(j, "\"2026-03-08T11:00:00Z\"");
        assert_eq!(serde_json::from_str::<Ts>(&j).unwrap(), t);
    }

    #[test]
    fn rejects_garbage() {
        assert!(serde_json::from_str::<Ts>("\"yesterday\"").is_err());
        assert!(Ts::parse("2026-13-01T00:00:00Z").is_none());
    }

    #[test]
    fn rejects_values_that_would_print_as_year_10000() {
        assert!(Ts::parse("9999-12-31T23:59:59-01:00").is_none());
        let max = Ts::parse("9999-12-31T23:59:59Z").unwrap();
        assert_eq!(max, Ts::MAX);
        assert_eq!(max.later(5), max);
        assert_eq!(Ts::parse(&max.iso()), Some(max));
    }
}
