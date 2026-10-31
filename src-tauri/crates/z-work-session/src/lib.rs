//! Whether this user's session is locked, read from the OS. Polled by the app's activity watcher.
//!
//! This asks rather than subscribes: `WTSRegisterSessionNotification` would need a window procedure,
//! a callback that foreign code calls into Rust. A query is one call with one buffer to free, and it
//! also sees a lock that began before the app did. The cost is up to one poll of delay.

/// `Some(true)` when locked, `Some(false)` when not, `None` when the OS can't say or on other systems.
#[must_use]
pub fn is_locked() -> Option<bool> {
    imp::is_locked()
}

/// The meaning of `WTSINFOEX_LEVEL1.SessionFlags`, where 0 is locked and 1 is unlocked.
#[cfg_attr(not(windows), allow(dead_code))]
const fn decode_flags(flags: u32) -> Option<bool> {
    match flags {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod imp {
    use core::ffi::c_void;
    use core::ptr;

    use windows_sys::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSFreeMemory, WTSINFOEXW,
        WTSQuerySessionInformationW, WTSSessionInfoEx,
    };

    /// Frees the buffer on every path out, including a panic.
    struct Buffer(*mut u16);

    impl Drop for Buffer {
        fn drop(&mut self) {
            // SAFETY: the pointer came from a successful WTSQuerySessionInformationW, which requires
            // this function to free it, and this guard is the buffer's only owner.
            unsafe { WTSFreeMemory(self.0.cast::<c_void>()) };
        }
    }

    pub fn is_locked() -> Option<bool> {
        let mut raw: *mut u16 = ptr::null_mut();
        let mut bytes: u32 = 0;
        // SAFETY: both out-pointers refer to live locals of the requested types. The two constants
        // are the documented way to name this machine and this session.
        let ok = unsafe {
            WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &raw mut raw,
                &raw mut bytes,
            )
        };
        if ok == 0 || raw.is_null() {
            return None;
        }
        let buffer = Buffer(raw);
        if (bytes as usize) < size_of::<WTSINFOEXW>() {
            return None;
        }
        // SAFETY: the call succeeded and reported at least a whole WTSINFOEXW at this pointer. For
        // the WTSSessionInfoEx class the OS allocates that struct, so it is suitably aligned.
        let info = unsafe { buffer.0.cast::<WTSINFOEXW>().read() };
        if info.Level != 1 {
            return None;
        }
        // SAFETY: Level 1 is the documented discriminant for the `WTSInfoExLevel1` union member, and
        // it is the union's only member.
        let flags = unsafe { info.Data.WTSInfoExLevel1.SessionFlags };
        super::decode_flags(flags.cast_unsigned())
    }
}

#[cfg(not(windows))]
mod imp {
    /// macOS has no equivalent as simple as this. There, locks are noticed through idle time.
    pub const fn is_locked() -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_decode_as_documented() {
        assert_eq!(decode_flags(0), Some(true));
        assert_eq!(decode_flags(1), Some(false));
        assert_eq!(decode_flags(u32::MAX), None, "WTS_SESSIONSTATE_UNKNOWN");
        assert_eq!(decode_flags(2), None);
    }

    /// On Windows this makes the real call, so CI exercises the FFI even with nobody at the machine.
    /// A service session may answer anything, so it only checks the call returns and repeats safely.
    #[test]
    fn asking_is_safe_and_repeatable() {
        for _ in 0..100 {
            let _ = is_locked();
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn other_systems_cannot_say() {
        assert_eq!(is_locked(), None);
    }
}
