//! Whether this user's session is locked, read from the OS. Polled by the app's activity watcher.
//!
//! This asks rather than subscribes: `WTSRegisterSessionNotification` would need a window procedure,
//! a callback that foreign code calls into Rust. A query is one call with one buffer to free, and it
//! also sees a lock that began before the app did. The cost is up to one poll of delay.
//!
//! Also whether this copy runs from an MSIX package (the Microsoft Store build), and its package identity:
//! two calls that fill a buffer on the stack, with nothing to free.

/// `Some(true)` when locked, `Some(false)` when not, `None` when the OS can't say or on other systems.
#[must_use]
pub fn is_locked() -> Option<bool> {
    imp::is_locked()
}

/// The package identity's full name when running from an MSIX package; None otherwise or on other systems.
#[must_use]
pub fn package_full_name() -> Option<String> {
    package::full_name()
}

/// The AppUserModelID Windows knows this app by when packaged, `<PackageFamilyName>!zWorkTracker`; None otherwise.
#[must_use]
pub fn application_user_model_id() -> Option<String> {
    package::application_user_model_id()
}

/// Room for either answer, in UTF-16 units. Windows caps a package full name at 127 characters and an
/// AppUserModelID at 130, both before the terminating nul.
const PACKAGE_BUFFER: u16 = 256;

/// What a `GetCurrentPackageFullName`-style call came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum PackageResult {
    /// The name's length in UTF-16 units, without the nul.
    Found(usize),
    /// Not packaged (`APPMODEL_ERROR_NO_PACKAGE`, 15700), or any other error: either way no identity to use.
    NoPackage,
}

/// Reads the error code and the length written back, which counts the terminating nul. A length that doesn't fit the
/// buffer is no answer.
#[cfg_attr(not(windows), allow(dead_code))]
fn decode_package_result(code: u32, len: u32) -> PackageResult {
    match (code, usize::try_from(len)) {
        (0, Ok(n)) if (1..=usize::from(PACKAGE_BUFFER)).contains(&n) => PackageResult::Found(n - 1),
        _ => PackageResult::NoPackage,
    }
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

#[cfg(windows)]
#[allow(unsafe_code)]
mod package {
    use windows_sys::Win32::Foundation::WIN32_ERROR;
    use windows_sys::Win32::Storage::Packaging::Appx::{
        GetCurrentApplicationUserModelId, GetCurrentPackageFullName,
    };
    use windows_sys::core::PWSTR;

    use super::{PACKAGE_BUFFER, PackageResult, decode_package_result};

    /// Both calls share one contract: the buffer's length in UTF-16 units goes in, and the length written, nul
    /// included, comes back. Neither keeps the pointers after it returns.
    type Query = unsafe extern "system" fn(*mut u32, PWSTR) -> WIN32_ERROR;

    /// # Safety
    ///
    /// `query` must write at most `*len` UTF-16 units into the buffer, report through `len`, and keep neither pointer
    /// after it returns, as `GetCurrentPackageFullName` and `GetCurrentApplicationUserModelId` document.
    unsafe fn ask(query: Query) -> Option<String> {
        let mut buffer = [0u16; PACKAGE_BUFFER as usize];
        let mut len = u32::from(PACKAGE_BUFFER);
        // SAFETY: `len` is the buffer's true length in UTF-16 units and both pointers are to live locals for the
        // whole call; the caller vouches that `query` stays within that length and keeps neither pointer.
        let code = unsafe { query(&raw mut len, buffer.as_mut_ptr()) };
        // The length is only trusted within the buffer, and `get` checks it again.
        match decode_package_result(code, len) {
            PackageResult::Found(n) => buffer.get(..n).map(String::from_utf16_lossy),
            PackageResult::NoPackage => None,
        }
    }

    pub fn full_name() -> Option<String> {
        // SAFETY: GetCurrentPackageFullName writes at most the length it is given and keeps no pointer.
        unsafe { ask(GetCurrentPackageFullName) }
    }

    pub fn application_user_model_id() -> Option<String> {
        // SAFETY: GetCurrentApplicationUserModelId writes at most the length it is given and keeps no pointer.
        unsafe { ask(GetCurrentApplicationUserModelId) }
    }
}

#[cfg(not(windows))]
mod package {
    /// Only Windows has packages.
    pub const fn full_name() -> Option<String> {
        None
    }

    pub const fn application_user_model_id() -> Option<String> {
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

    /// Test 62.
    #[test]
    fn package_results_decode_as_documented() {
        let full = u32::from(PACKAGE_BUFFER);
        let cases = [
            (0, 43, PackageResult::Found(42)),
            (0, 1, PackageResult::Found(0)),
            (
                0,
                full,
                PackageResult::Found(usize::from(PACKAGE_BUFFER) - 1),
            ),
            // Written past the buffer, or no nul counted: not an answer to trust.
            (0, full + 1, PackageResult::NoPackage),
            (0, 0, PackageResult::NoPackage),
            // APPMODEL_ERROR_NO_PACKAGE, APPMODEL_ERROR_NO_APPLICATION, ERROR_INSUFFICIENT_BUFFER.
            (15_700, 0, PackageResult::NoPackage),
            (15_703, 0, PackageResult::NoPackage),
            (122, 300, PackageResult::NoPackage),
            (u32::MAX, 10, PackageResult::NoPackage),
        ];
        for (code, len, want) in cases {
            assert_eq!(
                decode_package_result(code, len),
                want,
                "code {code}, len {len}"
            );
        }
    }

    /// On Windows this makes the real calls. A test runner isn't packaged, so both say so.
    #[test]
    fn an_unpackaged_process_has_no_package_identity() {
        for _ in 0..10 {
            assert_eq!(package_full_name(), None);
            assert_eq!(application_user_model_id(), None);
        }
    }
}
