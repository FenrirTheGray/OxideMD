// Native application menu bar.
//
// The menu mirrors the frontend action registry in `frontend/keybindings.js`:
// each actionable item's `MenuId` is the frontend action id string (e.g.
// `"save"`, `"openFile"`), so a click can be forwarded straight to the JS
// dispatcher. On a menu event we `emit` a `menu-action` event carrying the id
// string; `app.js` listens for it and runs the matching handler via
// `runAction`. Action logic lives entirely in the frontend — Rust only routes.
//
// The item list is hardcoded here (Rust can't read the JS registry) but uses
// the SAME id strings as `ACTIONS` so the mapping stays clean. Format actions
// are intentionally omitted — they're editor-only and toolbar/shortcut-driven.
// Edit items are `PredefinedMenuItem`s handled natively by the webview.

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub fn build_and_attach(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();

    // ── File ───────────────────────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&MenuItemBuilder::with_id("newFile", "New File").build(app)?)
        .item(&MenuItemBuilder::with_id("openFile", "Open File").build(app)?)
        .item(&MenuItemBuilder::with_id("openFolder", "Open Folder").build(app)?)
        .item(&MenuItemBuilder::with_id("closeFolder", "Close Folder").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save File").build(app)?)
        .item(&MenuItemBuilder::with_id("reload", "Reload File").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("print", "Print to PDF").build(app)?)
        .item(&MenuItemBuilder::with_id("exportHtml", "Export as HTML…").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit OxideMD"))?)
        .build()?;

    // ── Edit ───────────────────────────────────────────────────────────────
    // Predefined items — the webview + CodeMirror handle these natively.
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(app, Some("Undo"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Redo"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Cut"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copy"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Paste"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Select All"))?)
        .build()?;

    // ── View ───────────────────────────────────────────────────────────────
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&MenuItemBuilder::with_id("toggleEdit", "Toggle Edit Mode").build(app)?)
        .item(&MenuItemBuilder::with_id("cycleSplitMode", "Cycle Split Layout").build(app)?)
        .item(&MenuItemBuilder::with_id("toggleSearch", "Search").build(app)?)
        .item(&MenuItemBuilder::with_id("searchInFolder", "Search in Folder").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("zoomIn", "Zoom In").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomOut", "Zoom Out").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomReset", "Reset Zoom").build(app)?)
        .build()?;

    // ── Tabs ───────────────────────────────────────────────────────────────
    let tabs_menu = SubmenuBuilder::new(handle, "Tabs")
        .item(&MenuItemBuilder::with_id("nextTab", "Next Tab").build(app)?)
        .item(&MenuItemBuilder::with_id("prevTab", "Previous Tab").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("moveTabLeft", "Move Tab Left").build(app)?)
        .item(&MenuItemBuilder::with_id("moveTabRight", "Move Tab Right").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("closeTab", "Close Tab").build(app)?)
        .build()?;

    // ── Help ───────────────────────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(handle, "Help")
        .item(&MenuItemBuilder::with_id("about", "About OxideMD").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&tabs_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    // Forward custom menu items to the frontend dispatcher. Predefined items
    // (undo/redo/cut/copy/paste/select-all/quit) handle themselves and never
    // reach this handler — only our id'd items do.
    app.on_menu_event(|app_handle, event| {
        let id = event.id().as_ref();
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.emit("menu-action", id);
        }
    });

    Ok(())
}
