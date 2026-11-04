fn main() {
    // napi-build supplies the link flags (and the `-undefined dynamic_lookup` on
    // macOS) that let the cdylib resolve the host process's `napi_*` symbols at load
    // time. Without it a macOS build fails to link.
    napi_build::setup();
}
