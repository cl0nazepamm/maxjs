# handles.py - stable producer handle allocation for Blender live sessions.


def next_handle_after(handle_map, default=1):
    values = [int(v) for v in (handle_map or {}).values() if int(v) > 0]
    return max(values) + 1 if values else int(default)


def assign_stable_handles(names, existing_handle_map=None, next_handle=None):
    """Return (handle_map, next_handle) for the current object-name list.

    Handles already assigned to still-present names are preserved. New names get
    monotonically increasing handles so deleted handles are not recycled during
    the Live IPR session.
    """
    existing = existing_handle_map or {}
    assigned = {}
    used = set()

    for name in names:
        handle = existing.get(name)
        if handle is None:
            continue
        handle = int(handle)
        if handle <= 0 or handle in used:
            continue
        assigned[name] = handle
        used.add(handle)

    cursor = int(next_handle) if next_handle is not None else next_handle_after(existing)
    if used:
        cursor = max(cursor, max(used) + 1)
    cursor = max(cursor, 1)

    for name in names:
        if name in assigned:
            continue
        while cursor in used:
            cursor += 1
        assigned[name] = cursor
        used.add(cursor)
        cursor += 1

    return assigned, cursor


def assign_stable_object_handles(entries, existing_name_map=None,
                                 existing_id_map=None, next_handle=None):
    """Return (name_map, id_map, next_handle) for (name, object_id) entries.

    Live producers should use this instead of name-only allocation. Blender
    object IDs act like a session-local analog of a Max node handle: renaming an
    existing object preserves the producer handle, while real add/delete still
    changes the object table.
    """
    existing_names = existing_name_map or {}
    existing_ids = {int(k): int(v) for k, v in (existing_id_map or {}).items()}
    identity_mode = bool(existing_ids)
    assigned_names = {}
    assigned_ids = {}
    used = set()

    for name, object_id in entries:
        handle = None
        if object_id is not None:
            handle = existing_ids.get(int(object_id))
        if handle is None and (object_id is None or not identity_mode):
            handle = existing_names.get(name)
        if handle is None:
            continue
        handle = int(handle)
        if handle <= 0 or handle in used:
            continue
        assigned_names[name] = handle
        if object_id is not None:
            assigned_ids[int(object_id)] = handle
        used.add(handle)

    cursor = int(next_handle) if next_handle is not None else next_handle_after(existing_names)
    if existing_ids:
        cursor = max(cursor, next_handle_after(existing_ids))
    if used:
        cursor = max(cursor, max(used) + 1)
    cursor = max(cursor, 1)

    for name, object_id in entries:
        if name in assigned_names:
            continue
        while cursor in used:
            cursor += 1
        assigned_names[name] = cursor
        if object_id is not None:
            assigned_ids[int(object_id)] = cursor
        used.add(cursor)
        cursor += 1

    return assigned_names, assigned_ids, cursor
