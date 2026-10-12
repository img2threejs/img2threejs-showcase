#ifndef ISLAND_WATER_FIELDS_H
#define ISLAND_WATER_FIELDS_H
#include <stdint.h>

enum { N = 128, NN = N * N };
#define WASM_EXPORT(ret, name) __attribute__((used, visibility("default"))) ret name

extern double bed[NN], depth[NN], momentum_x[NN], momentum_z[NN];
extern double velocity_x[NN], velocity_z[NN], cell_widths[N];
extern float axis[N];
extern double foam[NN], wetness[NN], foam_offset_x[NN], foam_offset_z[NN];
extern double shore_normal_x[NN], shore_normal_z[NN], shore_impulse_x[NN], shore_impulse_z[NN];
extern uint32_t foam_candidates[NN];
extern double foam_compression[NN], foam_source_step[NN];

#endif
