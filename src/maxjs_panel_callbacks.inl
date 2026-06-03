void MaxJSFastNodeEventCallback::ControllerStructured(NodeKeyTab& nodes) {
    // Modifier stack changes (add/remove modifier) can change object type
    // (e.g. spline → extruded mesh). Treat as topology change for full rebuild.
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryTopologyDirty(nodes);
}

void MaxJSFastNodeEventCallback::ControllerOtherEvent(NodeKeyTab& nodes) {
    if (!owner_) return;
    if (owner_->IsAnimationPlaying()) {
        // During playback, TimeChanged already scans all transforms and
        // deform geometry every frame. Bone controller events fire once
        // per bone per frame — 50-bone rigs generate 50 callbacks with
        // redundant VisitNodeSubtree + CheckSkinnedGeometryLive work
        // that competes with Max's playback pacing and causes chop.
        return;
    }
    if (owner_->MarkControllerNodesDirty(nodes)) {
        owner_->MarkInteractiveActivity();
        owner_->CheckSkinnedGeometryLive();
    }
}

void MaxJSFastNodeEventCallback::LinkChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::SelectionChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkSelectionNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::HideChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkVisibilityNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::GeometryChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryPositionsDirty(nodes);
}

void MaxJSFastNodeEventCallback::TopologyChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryTopologyDirty(nodes);
}

void MaxJSFastNodeEventCallback::MaterialStructured(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkMaterialNodesDirty(nodes, true);
}

void MaxJSFastNodeEventCallback::MaterialOtherEvent(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkMaterialNodesDirty(nodes, false);
}

void MaxJSFastRedrawCallback::proc(Interface*) {
    if (!owner_) return;
    const bool animPlaying = owner_->IsAnimationPlaying();

    // Camera is cheap and should not be throttled by selected-transform or
    // geometry lanes; keep it on its own immediate dirty check.
    owner_->MarkCameraDirtyIfChanged(false);
    owner_->PollViewportModes();
    if (!animPlaying) owner_->PollSelectedTransformGizmoLive();

    // RedrawViewsCallback fires for viewport hover/selection highlight too.
    // During playback, high-polling-rate mouse movement can multiply redraw
    // callbacks without advancing time. Let TimeChanged/timer own playback
    // sync, and use redraw as a capped helper for real interactive edits.
    if (!animPlaying && owner_->ShouldPollSelectedGeometryLive() && owner_->ConsumeRedrawLivePollSlot()) {
        owner_->MarkSelectedTransformsDirty();
        owner_->CheckSelectedGeometryLive();
        owner_->CheckSkinnedGeometryLive();
    }

    if (owner_->ShouldRunInteractiveMaterialChecks()) {
        owner_->CheckTrackedMaterialScalarsLive();
    }
}

void MaxJSFastTimeChangeCallback::TimeChanged(TimeValue t) {
    if (!owner_) return;
    owner_->OnTimelineTimeChanged(t);
}

static void OnSceneChanged(void* param, NotifyInfo*) {
    auto* p = static_cast<MaxJSPanel*>(param);
    if (p) p->SetDirty();
}
