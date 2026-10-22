// Evita una finestra console extra su Windows; su Linux non ha effetto
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    calchy_lib::run()
}
