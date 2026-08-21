//! Dragging a capture out of Shotly and into another app.
//!
//! The macOS half of `platform::dragout`. A file dragged from a window onto
//! Slack, Mail or a Finder folder is the oldest gesture on the platform, and it
//! is not something a web view can do on its own: HTML drag-and-drop can hand
//! another *web page* a file, but the pasteboard it writes is not the one
//! AppKit reads when the drop lands outside the browser. So the drag has to be
//! started by AppKit, on the window's own content view, with the file's URL as
//! the pasteboard item — which is exactly what Finder does.
//!
//! # The event
//!
//! `beginDraggingSessionWithItems:event:source:` wants the mouse event that
//! started the drag, and by the time a command has crossed the IPC boundary the
//! event that is *current* may be anything at all. So one is made: a
//! left-mouse-dragged event at the pointer's position in the window. AppKit
//! only reads the location and the window from it, and a synthesised event is
//! honest about both — it is describing a drag the user really is in the middle
//! of, which the front end knows about and this side does not.
//!
//! # The source
//!
//! A dragging session needs a source object to answer one question — which
//! operations are on offer — and answering it wrongly means every drop target
//! in the system refuses the drag with no explanation. One instance is made and
//! deliberately never released: it holds no state, AppKit keeps only a weak
//! reference to it, and a source freed mid-drag is a crash in somebody else's
//! process.

use std::cell::OnceCell;
use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, AllocAnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
    NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSWindow, NSWorkspace,
};
use objc2_foundation::{
    NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
};

define_class!(
    /// Answers the one question a dragging session asks its source.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ShotlyDragSource"]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation_mask(
            &self,
            _session: &NSDraggingSession,
            context: NSDraggingContext,
        ) -> NSDragOperation {
            // Copy, never move: the file being dragged is the user's library
            // copy, and a drop that took it away would silently delete a
            // capture. Inside our own app there is nothing to drop onto, so
            // that context offers nothing at all.
            match context {
                NSDraggingContext::OutsideApplication => NSDragOperation::Copy,
                _ => NSDragOperation::None,
            }
        }
    }
);

thread_local! {
    /// One source for the life of the process. See the note above on why it is
    /// kept rather than made per drag.
    static SOURCE: OnceCell<Retained<DragSource>> = const { OnceCell::new() };
}

fn source(mtm: MainThreadMarker) -> Retained<DragSource> {
    SOURCE.with(|cell| {
        cell.get_or_init(|| unsafe { objc2::msg_send![DragSource::alloc(mtm), init] })
            .clone()
    })
}

/// How big the picture under the cursor is, in points.
///
/// Large enough to recognise which capture is being dragged and small enough
/// not to hide the thing it is being dropped on. Finder's own icons are 64 at
/// their largest; this is a screenshot rather than a document, so it earns a
/// little more.
const DRAG_IMAGE: f64 = 96.0;

/// The picture to drag: the capture itself, or the file's icon if it won't load.
fn preview(path: &str) -> Option<(Retained<NSImage>, NSSize)> {
    let ns_path = NSString::from_str(path);

    // A recording has no still to show, and a PNG that fails to decode has
    // nothing either. Both land on the icon the Finder would draw.
    let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &ns_path)
        .filter(|img| {
            let size = img.size();
            size.width > 0.0 && size.height > 0.0
        })
        .or_else(|| Some(NSWorkspace::sharedWorkspace().iconForFile(&ns_path)))?;

    let natural = image.size();
    if natural.width <= 0.0 || natural.height <= 0.0 {
        return None;
    }

    // Fitted rather than filled, so a tall scrolling capture is dragged as a
    // tall sliver instead of being cropped into an unrecognisable square.
    let scale = (DRAG_IMAGE / natural.width)
        .min(DRAG_IMAGE / natural.height)
        .min(1.0);
    Some((image, NSSize::new(natural.width * scale, natural.height * scale)))
}

/// Start dragging these files out of `window`.
///
/// Returns once the session has begun — the drag then belongs to AppKit and
/// runs until the user lets go, wherever that happens to be.
pub fn begin_file_drag(window: &tauri::WebviewWindow, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to drag".into());
    }
    let mtm = MainThreadMarker::new().ok_or("drag must start on the main thread")?;

    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("window has no backing NSWindow".into());
    }

    // SAFETY: Tauri hands us a live NSWindow for this webview, and the
    // `MainThreadMarker` above is the proof that we are where AppKit requires.
    unsafe {
        let ns_window = &*ptr;
        let view = ns_window
            .contentView()
            .ok_or("window has no content view")?;

        // Where the pointer is, in the view's own coordinates. The drag image
        // is centred on it so the capture appears under the cursor rather than
        // hanging off one corner of it.
        let in_window = ns_window.mouseLocationOutsideOfEventStream();
        let at = view.convertPoint_fromView(in_window, None);

        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            in_window,
            NSEventModifierFlags::empty(),
            NSApplication::sharedApplication(mtm)
                .currentEvent()
                .map(|e| e.timestamp())
                .unwrap_or(0.0),
            ns_window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("could not describe the drag to AppKit")?;

        let mut items: Vec<Retained<NSDraggingItem>> = Vec::with_capacity(paths.len());
        for (i, path) in paths.iter().enumerate() {
            if !Path::new(path).exists() {
                continue;
            }
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let item = NSDraggingItem::initWithPasteboardWriter(
                NSDraggingItem::alloc(),
                ProtocolObject::from_ref(&*url),
            );

            let (image, size) = match preview(path) {
                Some(pair) => pair,
                None => continue,
            };
            // Each extra file is offset a little so a multi-file drag reads as
            // a small stack rather than as one picture.
            let step = (i as f64) * 6.0;
            item.setDraggingFrame_contents(
                NSRect::new(
                    NSPoint::new(at.x - size.width / 2.0 + step, at.y - size.height / 2.0 - step),
                    size,
                ),
                Some(&image),
            );
            items.push(item);
        }

        if items.is_empty() {
            return Err("none of those files are still on disk".into());
        }

        let array = NSArray::from_retained_slice(&items);
        let src = source(mtm);
        view.beginDraggingSessionWithItems_event_source(
            &array,
            &event,
            ProtocolObject::from_ref(&*src),
        );
    }

    Ok(())
}
