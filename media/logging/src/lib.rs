pub enum Type {
    Network,
}
#[macro_export]
macro_rules! logging {
    ($level:ident, $kind:expr, $($message:tt)*) => {{ let _ = $kind; eprintln!($($message)*); }};
}
