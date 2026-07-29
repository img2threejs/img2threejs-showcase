# Tasks: Multi-View Synthesis Stage

## Phase 1: Foundation (Week 1)

### Task 1.1: Create Multi-View Synthesis Module
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: None

- [ ] Create `forge/stage1b_multi_view/` directory structure
- [ ] Implement `synthesize.py` - main entry point
- [ ] Implement `feature_detector.py` - SIFT/ORB feature detection
- [ ] Implement `feature_matcher.py` - cross-view feature matching
- [ ] Implement `pose_estimator.py` - relative camera pose estimation
- [ ] Implement `depth_estimator.py` - depth from parallax
- [ ] Add unit tests for each module

**Acceptance Criteria**:
- [ ] Can detect features in a single image
- [ ] Can match features between two views
- [ ] Can estimate relative pose between views
- [ ] Can compute depth cues from matched features
- [ ] All unit tests pass

### Task 1.2: Define Geometry Brief Schema
**Priority**: High  
**Estimate**: 1 day  
**Dependencies**: None

- [ ] Create `grimoire/multi_view/geometry_brief_schema.json`
- [ ] Define component geometry structure
- [ ] Define confidence scoring structure
- [ ] Define view coverage structure
- [ ] Add schema validation

**Acceptance Criteria**:
- [ ] Schema validates sample geometry briefs
- [ ] Schema is backwards compatible with existing specs
- [ ] Documentation is complete

### Task 1.3: Update Intake Record Schema
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 1.2

- [ ] Add `synthesis` field to `intake-record.json` schema
- [ ] Add `multiViewBrief` field to `object-sculpt-spec.json` schema
- [ ] Update validation scripts

**Acceptance Criteria**:
- [ ] New fields are optional (backwards compatible)
- [ ] Validation passes with and without new fields
- [ ] Documentation is updated

### Task 1.4: Implement View Count Detection
**Priority**: High  
**Estimate**: 1 day  
**Dependencies**: None

- [ ] Create `view_counter.py` - detect number of provided views
- [ ] Implement named view detection (front, back, top, etc.)
- [ ] Implement unnamed view auto-detection (clustering by angle)
- [ ] Implement duplicate view grouping (multiple angles of same view)
- [ ] Add unit tests for different view counts (1, 2, 3, 4, 5, 6, 7+)

**Acceptance Criteria**:
- [ ] Correctly counts 1 to N views
- [ ] Handles named views (front, back, top, left, right, bottom)
- [ ] Handles unnamed views (auto-detects angles)
- [ ] Groups duplicate views (multiple front angles)
- [ ] All unit tests pass

## Phase 2: Integration (Week 2)

### Task 2.1: Integrate Synthesis into Intake Pipeline
**Priority**: High  
**Estimate**: 2 days  
**Dependencies**: Task 1.1, Task 1.3

- [ ] Modify `forge/stage1_intake/intake.py` to call synthesis
- [ ] Add synthesis result to intake record
- [ ] Handle single-view fallback (skip synthesis)
- [ ] Handle variable view count (1 to N)
- [ ] Add error handling for synthesis failures

**Acceptance Criteria**:
- [ ] Intake with 1 view skips synthesis gracefully
- [ ] Intake with 2-3 views triggers basic synthesis
- [ ] Intake with 4-6 views triggers full synthesis
- [ ] Intake with 7+ views triggers optimal synthesis
- [ ] Synthesis failures are logged and handled
- [ ] Integration tests pass

### Task 2.2: Update Spec Generation to Use Brief
**Priority**: High  
**Estimate**: 2 days  
**Dependencies**: Task 1.2, Task 2.1

- [ ] Modify `forge/stage2_spec/new_sculpt_spec.py` to accept brief
- [ ] Implement `enhance_components_with_brief()` function
- [ ] Update component dimensions from brief
- [ ] Update curvature data from brief
- [ ] Add confidence scores to spec

**Acceptance Criteria**:
- [ ] Spec generation uses brief when available
- [ ] Spec falls back to existing logic when brief is missing
- [ ] Component dimensions match brief values
- [ ] Unit tests pass

### Task 2.3: Update Registry for Multiple References
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 1.3

- [ ] Add `referenceImages` (plural) field to `DemoEntry` type
- [ ] Update `src/demos/registry.ts` to support multiple images
- [ ] Maintain backwards compatibility with `referenceImage` (singular)

**Acceptance Criteria**:
- [ ] Registry accepts both singular and plural reference fields
- [ ] Plural field takes precedence when both are provided
- [ ] TypeScript compilation passes

## Phase 3: Build Integration (Week 3)

### Task 3.1: Update Build to Use Brief Dimensions
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: Task 2.2

- [ ] Modify `generate_threejs_factory.py` to use brief
- [ ] Update geometry generation to use brief dimensions
- [ ] Update curvature calculations from brief
- [ ] Add brief-aware component creation

**Acceptance Criteria**:
- [ ] Generated Three.js code uses brief dimensions
- [ ] Geometry matches brief specifications
- [ ] Generated code compiles and runs
- [ ] Visual output matches expected dimensions

### Task 3.2: Update Review to Compare Multiple Views
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: Task 2.3

- [ ] Modify `divine_eye.py` to accept multiple reference images
- [ ] Update silhouette IoU to compare against all views
- [ ] Update proportion delta to use multi-view data
- [ ] Add per-view scoring

**Acceptance Criteria**:
- [ ] Review compares against all provided views
- [ ] Scores are aggregated across views
- [ ] Review output includes per-view breakdown
- [ ] Unit tests pass

## Phase 4: Agent Integration (Week 4)

### Task 4.1: Create Multi-View Analysis Protocol
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: Task 1.1

- [ ] Create `grimoire/intake/multi_view_analysis.md`
- [ ] Define agent-driven analysis steps
- [ ] Define feature extraction guidelines
- [ ] Define synthesis workflow

**Acceptance Criteria**:
- [ ] Protocol is clear and actionable
- [ ] Agent can follow protocol consistently
- [ ] Protocol covers edge cases

### Task 4.2: Update Intake Skill
**Priority**: Medium  
**Estimate**: 1 day  
**Dependencies**: Task 4.1

- [ ] Update `item-reconstruction-intake/SKILL.md`
- [ ] Add multi-view synthesis mandate
- [ ] Update workflow steps
- [ ] Add examples

**Acceptance Criteria**:
- [ ] Skill mandates synthesis for multi-view inputs
- [ ] Skill provides clear instructions
- [ ] Examples are provided

### Task 4.3: Create Hybrid Synthesis Mode
**Priority**: Low  
**Estimate**: 3 days  
**Dependencies**: Task 1.1, Task 4.1

- [ ] Implement agent-driven synthesis fallback
- [ ] Combine deterministic and agent results
- [ ] Add confidence weighting
- [ ] Handle conflicts between methods

**Acceptance Criteria**:
- [ ] Hybrid mode works when deterministic fails
- [ ] Results are merged intelligently
- [ ] Confidence scores reflect method quality
- [ ] Unit tests pass

## Phase 5: Testing & Documentation (Week 5)

### Task 5.1: Create Test Suite
**Priority**: High  
**Estimate**: 3 days  
**Dependencies**: All previous tasks

- [ ] Create `tests/multi_view/` directory
- [ ] Add unit tests for feature detection
- [ ] Add unit tests for feature matching
- [ ] Add integration tests for full pipeline
- [ ] Add regression tests with known multi-view sets

**Acceptance Criteria**:
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Code coverage > 80%
- [ ] No regressions in existing tests

### Task 5.2: Create Documentation
**Priority**: Medium  
**Estimate**: 2 days  
**Dependencies**: All previous tasks

- [ ] Update `grimoire/scripts.md` with new scripts
- [ ] Create `docs/multi-view-synthesis.md` user guide
- [ ] Add API documentation
- [ ] Update README with multi-view examples

**Acceptance Criteria**:
- [ ] Documentation is complete
- [ ] Examples are provided
- [ ] API is documented
- [ ] User guide is clear

### Task 5.3: Performance Optimization
**Priority**: Low  
**Estimate**: 2 days  
**Dependencies**: Task 5.1

- [ ] Profile synthesis pipeline
- [ ] Optimize feature detection
- [ ] Optimize feature matching
- [ ] Add caching for repeated views

**Acceptance Criteria**:
- [ ] Synthesis completes in < 5 seconds for 6 views
- [ ] Memory usage is reasonable
- [ ] Caching improves repeated synthesis
- [ ] Benchmarks are documented

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

- [ ] Pipeline processes all 6 views for PS5 DualSense
- [ ] Model iterations reduced from 40+ to 10-15
- [ ] Divine Eye gates pass with multi-view data
- [ ] Backwards compatible with single-view inputs
- [ ] Documentation is complete
- [ ] All tests pass
