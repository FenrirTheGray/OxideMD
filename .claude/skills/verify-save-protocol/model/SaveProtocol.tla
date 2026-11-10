----------------------------- MODULE SaveProtocol -----------------------------
(***************************************************************************)
(* One OxideMD tab backed by one file, the file on disk, and another       *)
(* program that may change that file.                                      *)
(*                                                                         *)
(* Every action below is one indivisible step in the code: either one      *)
(* stretch of frontend JavaScript between two awaits, or one Rust command  *)
(* doing a single read or a single atomic rename. The comment on each      *)
(* action names the code it stands for. File contents are opaque tokens;   *)
(* a hash is modelled as the content it was computed from.                 *)
(*                                                                         *)
(* Read ../SKILL.md before changing this file.                             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxEdits,      \* how many times the user types
    MaxExt,        \* how many times another program writes the file

    \* What the user and the outside world may do. The baseline turns all of
    \* these off; each recorded finding turns exactly one on.
    Reopen,        \* the user opens the file that is already open
    OtherTabs,     \* the user opens or closes another tab or folder
    FolderOpen,    \* the file's folder is open in the sidebar
    ExtRename,     \* another program may save by renaming a new file over it
    ExtRestore,    \* another program may put back the content the file was opened with
    RaceExternal,  \* another program may write inside one in-flight operation
    RaceUser,      \* the user may act while a reload is in flight

    \* Guards in the code. TRUE is today's code; the self-test turns one off
    \* to show that the rule it protects then breaks.
    GuardHash,     \* saveActiveFile compares the live hash with tab.diskHash
    GuardDirty,    \* flushFsChanges skips a tab with unsaved edits
    GuardReload    \* reloadFile refuses a tab with unsaved edits

VARIABLES
    disk,          \* the file's content on disk
    raw,           \* tab.raw: the tab's buffer
    saved,         \* tab.savedRaw: what the tab believes is on disk
    view,          \* the CodeMirror document while editing, else None
    editing,       \* tab.editing
    diskHash,      \* tab.diskHash, or None before the first hash arrives
    hashQ,         \* file_sha256 calls in flight: None until read, then the content
    watching,      \* the OS watch on this file is alive
    fsEvent,       \* an fs-changed event is waiting in the 200 ms debounce
    suppress,      \* saveRecentlyFor(path): within 1.5 s of our own save
    reloadQ,       \* open_file reloads in flight, each [by, val]
    sv,            \* where saveActiveFile is: idle, hash, cmp, prompt, write, done
    svLive,        \* the live hash that save read
    svContent,     \* the content handed to save_file
    svConfirmed,   \* the user chose Overwrite in this save
    nEdits, nExt,  \* counters for the two bounds
    \* Bookkeeping for the rules. The app has no such state.
    work,          \* the latest text the user typed and has not saved or discarded
    lostExt,       \* a save replaced disk content the tab did not hold as saved, unasked
    falseAlarm     \* the overwrite warning appeared with nothing to overwrite

vars == <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
          suppress, reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
          work, lostExt, falseAlarm>>

None == <<"none", 0>>
Opened == <<"opened", 0>>          \* the content read when the tab was opened
Typed(n) == <<"typed", n>>         \* the buffer after the user's n-th edit
Outside(n) == <<"outside", n>>     \* the file after the n-th outside write

RemoveAt(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))

Dirty == raw # saved               \* isDirty(tab), core/tab-state.ts

\* Nothing is in flight: no hash request, no reload, and no save past its
\* first step. Each of those lasts milliseconds.
Settled == hashQ = <<>> /\ reloadQ = <<>> /\ sv \in {"idle", "prompt"}

\* The confirm dialog is modal. With RaceUser off, the user acts only when
\* nothing is in flight; with it on, at any moment.
UserFree == sv # "prompt" /\ (RaceUser \/ Settled)

\* With RaceExternal off, other programs write only when nothing is in
\* flight; with it on, at any moment.
ExtFree == RaceExternal \/ Settled

Init ==
    /\ disk = Opened /\ raw = Opened /\ saved = Opened
    /\ view = None /\ editing = FALSE
    /\ diskHash = None
    /\ hashQ = <<None>>            \* loadFile has just asked for the hash
    /\ watching = TRUE /\ fsEvent = FALSE /\ suppress = FALSE
    /\ reloadQ = <<>>
    /\ sv = "idle" /\ svLive = None /\ svContent = None /\ svConfirmed = FALSE
    /\ nEdits = 0 /\ nExt = 0
    /\ work = None
    /\ lostExt = FALSE /\ falseAlarm = FALSE

----------------------------------------------------------------------------
\* The user

\* enterEditMode, editor/editor.ts. buildView seeds the editor from tab.raw.
EnterEdit ==
    /\ UserFree /\ ~editing
    /\ editing' = TRUE /\ view' = raw
    /\ UNCHANGED <<disk, raw, saved, diskHash, hashQ, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* onDocChanged in buildView, editor/editor.ts: cur.raw = newDoc.
Type ==
    /\ UserFree /\ editing /\ nEdits < MaxEdits
    /\ nEdits' = nEdits + 1
    /\ view' = Typed(nEdits + 1) /\ raw' = Typed(nEdits + 1) /\ work' = Typed(nEdits + 1)
    /\ UNCHANGED <<disk, saved, editing, diskHash, hashQ, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nExt,
                   lostExt, falseAlarm>>

\* exitEditMode, editor/editor.ts. It does not copy the editor into tab.raw.
ExitEdit ==
    /\ UserFree /\ editing
    /\ editing' = FALSE /\ view' = None
    /\ UNCHANGED <<disk, raw, saved, diskHash, hashQ, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* discardActiveFile, editor/editor.ts, after the user confirms.
Discard ==
    /\ UserFree /\ editing /\ Dirty
    /\ raw' = saved /\ view' = saved /\ work' = None
    /\ UNCHANGED <<disk, saved, editing, diskHash, hashQ, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   lostExt, falseAlarm>>

\* reloadFile, ui/tabs.ts: the guard, then the open_file call goes out.
UserReload ==
    /\ UserFree /\ reloadQ = <<>>
    /\ ~editing /\ (GuardReload => ~Dirty)
    /\ reloadQ' = Append(reloadQ, [by |-> "user", val |-> None])
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* loadFile, ui/tabs.ts, for a path that already has a tab: openInNewTab only
\* switches to it (parking the editor into tab.raw), then file_sha256 goes out
\* and its result is stored on the existing tab.
ReopenSameFile ==
    /\ Reopen /\ UserFree /\ Len(hashQ) < 2
    /\ raw' = IF editing THEN view ELSE raw
    /\ hashQ' = Append(hashQ, None)
    /\ UNCHANGED <<disk, saved, view, editing, diskHash, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* syncWatcher, ui/folder.ts, runs whenever a tab or folder opens or closes;
\* set_watch_paths, src-tauri/src/watcher.rs, then builds a fresh watcher.
OtherTabChanges ==
    /\ OtherTabs /\ UserFree /\ ~watching
    /\ watching' = TRUE
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

----------------------------------------------------------------------------
\* Saving: saveActiveFile, editor/editor.ts

\* Up to the first await. With no tab.diskHash yet the check is skipped and
\* save_file goes out at once with the current buffer.
SaveStart ==
    /\ UserFree /\ sv = "idle" /\ Dirty /\ Len(hashQ) < 2
    /\ IF GuardHash /\ diskHash # None
       THEN sv' = "hash" /\ UNCHANGED svContent
       ELSE sv' = "write" /\ svContent' = raw
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, reloadQ, svLive, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* file_sha256, src-tauri/src/commands.rs, reads the file.
SaveHashRead ==
    /\ sv = "hash"
    /\ svLive' = disk /\ sv' = "cmp"
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, reloadQ, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* Back in JavaScript: compare with tab.diskHash as it is now. On a match
\* save_file goes out in the same step with the buffer as it is now.
SaveCompare ==
    /\ sv = "cmp"
    /\ IF svLive # diskHash
       THEN /\ sv' = "prompt"
            /\ falseAlarm' = (falseAlarm \/ svLive = saved)
            /\ UNCHANGED svContent
       ELSE /\ sv' = "write" /\ svContent' = raw
            /\ UNCHANGED falseAlarm
    /\ svLive' = None
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, reloadQ, svConfirmed, nEdits, nExt,
                   work, lostExt>>

\* promptOverwriteChanged, ui/confirm.ts: the user chooses Overwrite.
PromptOverwrite ==
    /\ sv = "prompt"
    /\ sv' = "write" /\ svContent' = raw /\ svConfirmed' = TRUE
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, reloadQ, svLive, nEdits, nExt, work,
                   lostExt, falseAlarm>>

\* The user chooses Cancel.
PromptCancel ==
    /\ sv = "prompt"
    /\ sv' = "idle"
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, reloadQ, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* save_file -> atomic_write, src-tauri/src/commands.rs: a temp file is renamed
\* over the target. The watcher reports that rename, and a watch on the file
\* itself (no folder open) then points at the replaced file and goes quiet.
SaveWrite ==
    /\ sv = "write"
    /\ lostExt' = (lostExt \/ (disk # saved /\ ~svConfirmed))
    /\ disk' = svContent
    /\ work' = IF work = svContent THEN None ELSE work
    /\ fsEvent' = (fsEvent \/ watching)
    /\ watching' = (watching /\ FolderOpen)
    /\ sv' = "done"
    /\ UNCHANGED <<raw, saved, view, editing, diskHash, hashQ, suppress, reloadQ,
                   svLive, svContent, svConfirmed, nEdits, nExt, falseAlarm>>

\* Back in JavaScript after save_file: tab.savedRaw, state.lastSaveAt, and a
\* fresh file_sha256 call whose result will become tab.diskHash.
SaveDone ==
    /\ sv = "done"
    /\ saved' = svContent /\ suppress' = TRUE
    /\ hashQ' = Append(hashQ, None)
    /\ sv' = "idle" /\ svConfirmed' = FALSE /\ svContent' = None
    /\ UNCHANGED <<disk, raw, view, editing, diskHash, watching, fsEvent, reloadQ,
                   svLive, nEdits, nExt, work, lostExt, falseAlarm>>

\* SAVE_SUPPRESS_MS (1500) runs out, core/tab-state.ts.
SuppressExpires ==
    /\ suppress /\ suppress' = FALSE
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

----------------------------------------------------------------------------
\* Hashes requested by loadFile and saveActiveFile (fire and forget)

\* file_sha256 reads the file.
HashRead(i) ==
    /\ hashQ[i] = None
    /\ hashQ' = [hashQ EXCEPT ![i] = disk]
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* The .then callback stores it: tab.diskHash = hash. Calls can finish in any order.
HashApply(i) ==
    /\ hashQ[i] # None
    /\ diskHash' = hashQ[i]
    /\ hashQ' = RemoveAt(hashQ, i)
    /\ UNCHANGED <<disk, raw, saved, view, editing, watching, fsEvent, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

----------------------------------------------------------------------------
\* Another program

\* It rewrites the file in place. The watch survives.
OutsideWrite ==
    /\ ExtFree /\ nExt < MaxExt
    /\ nExt' = nExt + 1 /\ disk' = Outside(nExt + 1)
    /\ fsEvent' = (fsEvent \/ watching)
    /\ UNCHANGED <<raw, saved, view, editing, diskHash, hashQ, watching, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits,
                   work, lostExt, falseAlarm>>

\* It puts back the content the file had when the tab opened it, as
\* `git checkout` of the earlier branch does.
OutsideRestore ==
    /\ ExtRestore /\ ExtFree /\ nExt < MaxExt /\ disk # Opened
    /\ nExt' = nExt + 1 /\ disk' = Opened
    /\ fsEvent' = (fsEvent \/ watching)
    /\ UNCHANGED <<raw, saved, view, editing, diskHash, hashQ, watching, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits,
                   work, lostExt, falseAlarm>>

\* It saves by renaming a new file over the old one, as many editors do.
OutsideRename ==
    /\ ExtRename /\ ExtFree /\ nExt < MaxExt
    /\ nExt' = nExt + 1 /\ disk' = Outside(nExt + 1)
    /\ fsEvent' = (fsEvent \/ watching)
    /\ watching' = (watching /\ FolderOpen)
    /\ UNCHANGED <<raw, saved, view, editing, diskHash, hashQ, suppress,
                   reloadQ, sv, svLive, svContent, svConfirmed, nEdits,
                   work, lostExt, falseAlarm>>

----------------------------------------------------------------------------
\* Reloading

\* flushFsChanges, ui/folder.ts, up to its await: the guard, then open_file
\* goes out. An event that fails the guard is dropped for good.
FsFlush ==
    /\ fsEvent /\ reloadQ = <<>> /\ fsEvent' = FALSE
    /\ IF editing \/ (GuardDirty /\ Dirty) \/ suppress
       THEN UNCHANGED reloadQ
       ELSE reloadQ' = Append(reloadQ, [by |-> "watcher", val |-> None])
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, suppress,
                   sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* open_file, src-tauri/src/commands.rs, reads the file.
ReloadRead(i) ==
    /\ reloadQ[i].val = None
    /\ reloadQ' = [reloadQ EXCEPT ![i].val = disk]
    /\ UNCHANGED <<disk, raw, saved, view, editing, diskHash, hashQ, watching, fsEvent,
                   suppress, sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

\* Back in JavaScript: tab.raw and tab.savedRaw take the content read.
\* tab.diskHash is not touched. The watcher path leaves a mounted editor
\* alone; reloadFile ends in applyActiveTab, which rebuilds it from tab.raw.
ReloadApply(i) ==
    /\ reloadQ[i].val # None
    /\ raw' = reloadQ[i].val /\ saved' = reloadQ[i].val
    /\ view' = IF editing /\ reloadQ[i].by = "user" THEN reloadQ[i].val ELSE view
    /\ reloadQ' = RemoveAt(reloadQ, i)
    /\ UNCHANGED <<disk, editing, diskHash, hashQ, watching, fsEvent, suppress,
                   sv, svLive, svContent, svConfirmed, nEdits, nExt,
                   work, lostExt, falseAlarm>>

----------------------------------------------------------------------------

HashReads == \E i \in 1..Len(hashQ) : HashRead(i)
HashApplies == \E i \in 1..Len(hashQ) : HashApply(i)
ReloadReads == \E i \in 1..Len(reloadQ) : ReloadRead(i)
ReloadApplies == \E i \in 1..Len(reloadQ) : ReloadApply(i)

Next ==
    \/ EnterEdit \/ Type \/ ExitEdit \/ Discard \/ UserReload
    \/ ReopenSameFile \/ OtherTabChanges
    \/ SaveStart \/ SaveHashRead \/ SaveCompare \/ PromptOverwrite \/ PromptCancel
    \/ SaveWrite \/ SaveDone \/ SuppressExpires
    \/ HashReads \/ HashApplies
    \/ OutsideWrite \/ OutsideRename \/ OutsideRestore
    \/ FsFlush
    \/ ReloadReads \/ ReloadApplies

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* The rules

\* A save never replaces disk content other than what the tab holds as saved
\* (what it last loaded or wrote), unless the user chose Overwrite.
NoSilentOverwrite == ~lostExt

\* Text the user typed is in the buffer, in the editor, or on its way to
\* disk, until they save or discard it.
NoLostEdits ==
    \/ work = None
    \/ raw = work
    \/ view = work
    \/ (sv = "write" /\ svContent = work)

\* With nothing in flight, a tab in reading mode with no unsaved edits shows
\* what is on disk.
TabNotStale ==
    (~editing /\ ~Dirty /\ ~fsEvent /\ reloadQ = <<>> /\ sv = "idle") => raw = disk

\* The "File changed on disk" warning appears only when the disk differs
\* from what the tab holds as saved.
NoFalseWarning == ~falseAlarm

\* While the file is open, OxideMD keeps watching it.
WatcherStaysArmed == watching

=============================================================================
