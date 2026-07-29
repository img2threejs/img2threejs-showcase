# Tasks: Multi-View Synthesis Stage

## Phase 1: Foundation (Week 1)

### Task 1.1: Create Multi-View Synthesis Module
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: None

- [x] Create `forge/stage1b_multi_view/` directory structure
- [x] Implement `synthesize.py` - main entry point
- [x] Implement `feature_detector.py` - SIFT/ORB feature detection
- [x] Implement `feature_matcher.py` - cross-view feature matching
- [x] Implement `pose_estimator.py` - relative camera pose estimation
- [x] Implement `depth_estimator.py` - depth from parallax
- [x] Add unit tests for each module

**Acceptance Criteria**:
- [x] Can detect features in a single image
- [x] Can match features between two views
- [x] Can estimate relative pose between views
- [x] Can compute depth cues from matched features
- [x] All unit tests pass

### Task 1.2: Define Geometry Brief Schema
**Priority**: High  
**Estimate**: 1 day  
**Dependencies**: None

- [x] Create `grimoire/multi_view/geometry_brief_schema.json`
- [x] Define component geometry structure
- [x] Define confidence scoring structure
- [x] Define view coverage structure
- [x] Add schema validation

**Acceptance Criteria**:
- [x] Schema validates sample geometry briefs
- [x] Schema is backwards compatible with existing specs
- [x] Documentation is complete

### Task 1.3: Update Intake Record Schema
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 1.2

- [x] Add `synthesis` field to `intake-record.json` schema
- [x] Add `multiViewBrief` field to `object-sculpt-spec.json` schema
- [x] Update validation scripts

**Acceptance Criteria**:
- [x] New fields are optional (backwards compatible)
- [x] Validation passes with and without new fields
- [x] Documentation is updated

### Task 1.4: Implement View Count Detection
**Priority**: High  
**Estimate**: 1 day  
**Dependencies**: None

- [x] Create `view_counter.py` - detect number of provided views
- [x] Implement named view detection (front, back, top, etc.)
- [x] Implement unnamed view auto-detection (clustering by angle)
- [x] Implement duplicate view grouping (multiple angles of same view)
- [x] Add unit tests for different view counts (1, 2, 3, 4, 5, 6, 7+)

**Acceptance Criteria**:
- [x] Correctly counts 1 to N views
- [x] Handles named views (front, back, top, left, right, bottom)
- [x] Handles unnamed views (auto-detects angles)
- [x] Groups duplicate views (multiple front angles)
- [x] All unit tests pass

## Phase 2: Integration (Week 2)

### Task 2.1: Integrate Synthesis into Intake Pipeline
**Priority**: High  
**Estimate**: 2 days  
**Dependencies**: Task 1.1, Task 1.3

- [x] Modify `forge/stage1_intake/intake.py` to call synthesis
- [x] Add synthesis result to intake record
- [x] Handle single-view fallback (skip synthesis)
- [x] Handle variable view count (1 to N)
- [x] Add error handling for synthesis failures

**Acceptance Criteria**:
- [x] Intake with 1 view skips synthesis gracefully
- [x] Intake with 2-3 views triggers basic synthesis
- [x] Intake with 4-6 views triggers full synthesis
- [x] Intake with 7+ views triggers optimal synthesis
- [x] Synthesis failures are logged and handled
- [x] Integration tests pass

### Task 2.2: Update Spec Generation to Use Brief
**Priority**: High  
**Estimate**: 2 days  
**Dependencies**: Task 1.2, Task 2.1

- [x] Modify `forge/stage2_spec/new_sculpt_spec.py` to accept brief
- [x] Implement `enhance_components_with_brief()` function
- [x] Update component dimensions from brief
- [x] Update curvature data from brief
- [x] Add confidence scores to spec

**Acceptance Criteria**:
- [x] Spec generation uses brief when available
- [x] Spec falls back to existing logic when brief is missing
- [x] Component dimensions match brief values
- [x] Unit tests pass

### Task 2.3: Update Registry for Multiple References
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 1.3

- [x] Add `referenceImages` (plural) field to `DemoEntry` type
- [x] Update `src/demos/registry.ts` to support multiple images
- [x] Maintain backwards compatibility with `referenceImage` (singular)

**Acceptance Criteria**:
- [x] Registry accepts both singular and plural reference fields
- [x] Plural field takes precedence when both are provided
- [x] TypeScript compilation passes

## Phase 3: Build Integration (Week 3)

### Task 3.1: Update Build to Use Brief Dimensions
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: Task 2.2

- [x] Modify `generate_threejs_factory.py` to use brief
- [x] Update geometry generation to use brief dimensions
- [x] Update curvature calculations from brief
- [x] Add brief-aware component creation

**Acceptance Criteria**:
- [x] Generated Three.js code uses brief dimensions
- [x] Geometry matches brief specifications
- [x] Generated code compiles and runs
- [x] Visual output matches expected dimensions

### Task 3.2: Update Review to Compare Multiple Views
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: Task 2.3

- [x] Modify `divine_eye.py` to accept multiple reference images
- [x] Update silhouette IoU to compare against all views
- [x] Update proportion delta to use multi-view data
- [x] Add per-view scoring

**Acceptance Criteria**:
- [x] Review compares against all provided views
- [x] Scores are aggregated across views
- [x] Review output includes per-view breakdown
- [x] Unit tests pass

## Phase 4: Agent Integration (Week 4)

### Task 4.1: Create Multi-View Analysis Protocol
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: Task 1.1

- [x] Create `grimoire/intake/multi_view_analysis.md`
- [x] Define agent-driven analysis steps
- [x] Define feature extraction guidelines
- [x] Define synthesis workflow

**Acceptance Criteria**:
- [x] Protocol is clear and actionable
- [x] Agent can follow protocol consistently
- [x] Protocol covers edge cases

### Task 4.2: Update Intake Skill
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 4.1

- [x] Update `item-reconstruction-intake/SKILL.md`
- [x] Add multi-view synthesis mandate
- [x] Update workflow steps
- [x] Add examples

**Acceptance Criteria**:
- [x] Skill mandates synthesis for multi-view inputs
- [x] Skill provides clear instructions
- [x] Examples are provided

### Task 4.3: Create Hybrid Synthesis Mode
**Priority**: Low  
**Estimate**: 3 days  
**Dependencies**: Task 1.1, Task 4.1

- [x] Implement agent-driven synthesis fallback
- [x] Combine deterministic and agent results
- [x] Add confidence weighting
- [x] Handle conflicts between methods

**Acceptance Criteria**:
- [x] Hybrid mode works when deterministic fails
- [x] Results are merged intelligently
- [x] Confidence scores reflect method quality
- [x] Unit tests pass

## Phase 5: Testing & Documentation (Week 5)

### Task 5.1: Create Test Suite
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: All previous tasks

- [x] Create `tests/multi_view/` directory
- [x] Add unit tests for feature detection
- [x] Add unit tests for feature matching
- [x] Add integration tests for full pipeline
- [x] Add regression tests with known multi-view sets

**Acceptance Criteria**:
- [x] All unit tests pass
- [x] All integration tests pass
- [x] Code coverage > 80%
- [x] No regressions in existing tests

### Task 5.2: Create Documentation
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: All previous tasks

- [x] Update `grimoire/scripts.md` with new scripts
- [x] Create `docs/multi-view-synthesis.md` user guide
- [x] Add API documentation
- [x] Update README with multi-view examples

**Acceptance Criteria**:
- [x] Documentation is complete
- [x] Examples are provided
- [x] API is documented
- [x] User guide is clear

### Task 5.3: Performance Optimization
**Priority**: Low  
**Estimate**: 2 days  
**Dependencies**: Task 5.1

- [x] Profile synthesis pipeline
- [x] Optimize feature detection
- [x] Optimize feature matching
- [x] Add caching for repeated views

**Acceptance Criteria**:
- [x] Synthesis completes in < 5 seconds for 6 views
- [x] Memory usage is reasonable
- [x] Caching improves repeated synthesis
- [x] Benchmarks are documented

## Milestones

| Milestone | Target Date | Dependencies |
|-----------|-------------|--------------|
| Foundation Complete | Week 1 | - |
| Integration Complete | Week 2 | Foundation |
| Build Integration Complete | Week 3 | Integration |
| Agent Integration Complete | Week 4 | Build Integration |
| Testing & Documentation Complete | Week 5 | Agent Integration |
| **Release** | **Week 6** | All |

## Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Feature matching fails on real images | Medium | High | Implement agent-driven fallback |
| Performance too slow | Low | Medium | Add caching, optimize algorithms |
| Backwards compatibility breaks | Low | High | Extensive testing, optional fields |
| Agent synthesis inconsistent | Medium | Medium | Hybrid mode, confidence weighting |

## Success Criteria

- [x] Pipeline processes all 6 views for PS5 DualSense
- [x] Model iterations reduced from 40+ to 10-15
- [x] Divine Eye gates pass with multi-view data
- [x] Backwards compatible with single-view inputs
- [x] Documentation is complete
- [x] All tests pass
