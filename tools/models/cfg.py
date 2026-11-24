# Per-model normalisation: source npz, forward axis in model XZ, real length (m) of the body, crop box (model units).
CFG = {
  'ifv2':     dict(src='Kurganets-25_Armored_Warfare', fwd=(0, 1), length=7.4, ymin=-1e9),
  'atcst':    dict(src='Kamaz_4310', fwd=(1, 0), length=7.65),
  'uaz':      dict(src='Military_Uaz_469_car_3D_model', fwd=(1, 0), length=4.03),
  'tigr':     dict(src='GAZ-2330_Tigr', fwd=(1, 0), length=5.7),
  'brdm':     dict(src='BRDM-2', fwd=(-1, 0), length=5.75),
  'grad':     dict(src='__-21_______BM-21_Grad', fwd=(0, 1), length=7.35),
  'smerch':   dict(src='Low_poly_Bm_30_Smerch', fwd=(0, -1), length=12.1),
  'radar':    dict(src='96L6E_mobile_anti-air_radar', fwd=(0, 1), length=10.7),
  'tel':      dict(src='Iskander-M_low-poly', fwd=(0, 1), length=13.07, crop=dict(xmax=2.0)),
  'gunship':  dict(src='Mi-24_Helicopter_Free', fwd=(1, 0), length=17.5, heli=True),
  'utilheli': dict(src='Mil_Mi-17', fwd=(0, -1), length=18.4, heli=True),
  'reconheli':dict(src='Mil_Mi_2_Hopelite', fwd=(-1, 0), length=11.4, heli=True),
  'heavyheli':dict(src='Mi26', fwd='pca', length=33.7, heli=True),
  'lightattack': dict(src='Yak-130_War_Thunder_Heavy_Cavalry', fwd=(0, 1), length=11.49),
  'fighter2': dict(src='Sukhoi_Su-35_-_Fighter_Jet_-_Free', fwd=(1, 0), length=21.9),
  'fighter3': dict(src='MiG-31_DCS_World', fwd=(0, 1), length=22.7),
}
