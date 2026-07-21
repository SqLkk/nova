#!/usr/bin/env python3
"""Path Engine — düz sorgu satırlarını hiyererarşik yapılara çevirir.

Path Definer'ın beyni. Bir saved query'nin satırlarını alır ve yapı tipine
göre navigasyonluk bir ağaca/zincire dönüştürür; veriye düz filtreden ziyade
hiyerarşik drill (Tesis → Hat → Makine → Sensör) sağlar.

Desteklenen yapılar:
  - tree / binary_tree : parent_id ile n'li ağaç (binary: >2 çocuk → uyarı)
  - sequence           : next_id bağlı liste VEYA order kolonuyla sıralı zincir
  - grouped            : bir kolona göre grup (1 seviyeli)

Çıktı tek bir dict'tir:
  {
    'nodes': [{id, label, parent, depth, path, type, children, row}, ...],
    'roots': [id, ...],
    'paths': [[id, ...], ...],   # kök→yaprak zincirleri
    'stats': {node_count, path_count, max_depth, warnings: [...]},
  }

Hata yok, exception fırlatmaz — sorunları warnings içine yazar (UI gösterir).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

__all__ = ["build_structure"]


def build_structure(structure: str, rows: List[Dict[str, Any]],
                    config: Dict[str, Any]) -> Dict[str, Any]:
    """Yapı tipine göre ilgili kurucuya yönlendir."""
    structure = (structure or "").strip()
    if structure in ("tree", "binary_tree"):
        return _build_tree(rows, config, binary=(structure == "binary_tree"))
    if structure == "sequence":
        return _build_sequence(rows, config)
    if structure == "grouped":
        return _build_grouped(rows, config)
    # Bilinmeyen tip — boş sonuç + uyarı (exception yok).
    return _empty_result([f"Bilinmeyen yapı tipi: {structure}"])


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

def _cell(row: Dict[str, Any], col: Optional[str]):
    """Satırdan kolon değeri; kolon yoksa None (alias farklarına toleranslı)."""
    if not col:
        return None
    return row.get(col)


def _norm_id(v) -> str:
    return "" if v is None else str(v)


def _is_root(val, root_value) -> bool:
    """parent değeri 'kök' anlamına gelir mi?"""
    if root_value not in (None, ""):
        return str(val) == str(root_value)
    return val is None or str(val).strip() == ""


def _empty_result(warnings: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "nodes": [], "roots": [], "paths": [],
        "stats": {
            "node_count": 0, "path_count": 0, "max_depth": 0,
            "warnings": warnings or [],
        },
    }


def _sort_numeric_then_str(items, key):
    """Sayısal değerleri önce, sonra dizgileri sırala (karışık tip güvenli)."""
    def k(item):
        v = key(item)
        if v is None:
            return (2, "")
        try:
            return (0, float(v))
        except (TypeError, ValueError):
            return (1, str(v))
    return sorted(items, key=k)


# ---------------------------------------------------------------------------
# Tree / Binary Tree
# ---------------------------------------------------------------------------

def _build_tree(rows, config, binary=False) -> Dict[str, Any]:
    id_col = config.get("id_col")
    parent_col = config.get("parent_col")
    label_col = config.get("label_col") or id_col
    type_col = config.get("type_col")
    root_value = config.get("root_value")
    warnings: List[str] = []

    if not id_col or not parent_col:
        return _empty_result(["Tree için id_col ve parent_col gerekli."])

    by_id: Dict[str, Dict[str, Any]] = {}
    dup = 0
    for r in rows:
        nid = _norm_id(_cell(r, id_col))
        if not nid:
            continue
        if nid in by_id:
            dup += 1
            continue
        label_val = _cell(r, label_col)
        by_id[nid] = {
            "id": nid,
            "label": str(label_val) if label_val is not None else nid,
            "parent": _norm_id(_cell(r, parent_col)),
            "depth": 0, "path": [], "type": "",
            "children": [], "row": r,
        }
        if type_col:
            tv = _cell(r, type_col)
            by_id[nid]["type"] = str(tv) if tv is not None else ""
    if dup:
        warnings.append(f"{dup} tekrarlı id atlandı.")

    # children haritası + kök tespiti.
    children: Dict[str, List[str]] = {}
    roots: List[str] = []
    for nid, node in by_id.items():
        pid = node["parent"]
        dangling = pid and pid not in by_id and not _is_root(pid, root_value) and pid != nid
        if dangling:
            warnings.append(f"'{nid}'nin parent'ı '{pid}' bulunamadı → kök kabul edildi.")
        if _is_root(pid, root_value) or pid == nid or pid not in by_id:
            roots.append(nid)
        else:
            children.setdefault(pid, []).append(nid)

    if binary:
        for pid, kids in children.items():
            if len(kids) > 2:
                warnings.append(f"Binary ihlali: '{pid}' düğümünde {len(kids)} çocuk (>2).")

    # DFS (iteratif — derin ağaçlarda recursion limit yok): depth/path/children + döngü.
    visited = set()
    max_depth = 0
    leaf_paths: List[List[str]] = []
    # Stack: (node_id, chain_so_far)
    for root in roots:
        stack: List[tuple] = [(root, [])]
        while stack:
            nid, chain = stack.pop()
            if nid in visited:
                warnings.append(f"Döngü tespit edildi: '{nid}' → zincir kesildi.")
                continue
            visited.add(nid)
            node = by_id[nid]
            node["depth"] = len(chain)
            node["path"] = chain + [nid]
            max_depth = max(max_depth, node["depth"])
            kids = children.get(nid, [])
            node["children"] = kids
            if not kids:
                leaf_paths.append(node["path"])
            for k in reversed(kids):  # sırayı koru
                stack.append((k, node["path"]))

    if not leaf_paths and roots:
        leaf_paths = [[r] for r in roots]

    return {
        "nodes": list(by_id.values()), "roots": roots, "paths": leaf_paths,
        "stats": {
            "node_count": len(by_id), "path_count": len(leaf_paths),
            "max_depth": max_depth, "warnings": warnings,
        },
    }


# ---------------------------------------------------------------------------
# Sequence
# ---------------------------------------------------------------------------

def _build_sequence(rows, config) -> Dict[str, Any]:
    id_col = config.get("id_col")
    next_col = config.get("next_col")
    order_col = config.get("order_col")
    label_col = config.get("label_col") or id_col
    warnings: List[str] = []

    if not id_col:
        return _empty_result(["Sequence için id_col gerekli."])
    if not next_col and not order_col:
        return _empty_result(["Sequence için next_col veya order_col gerekli."])

    by_id: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        nid = _norm_id(_cell(r, id_col))
        if not nid or nid in by_id:
            continue
        label_val = _cell(r, label_col)
        by_id[nid] = {
            "id": nid,
            "label": str(label_val) if label_val is not None else nid,
            "parent": "", "depth": 0, "path": [], "type": "", "children": [],
            "next": _norm_id(_cell(r, next_col)) if next_col else "",
            "row": r,
        }

    # order tabanlı: tek sıralı zincir.
    if order_col and not next_col:
        ordered = _sort_numeric_then_str(list(by_id.items()), key=lambda kv: _cell(kv[1]["row"], order_col))
        chain = [nid for nid, _ in ordered]
        return _finalize_chain(chain, by_id, warnings)

    # next_col bağlı liste.
    referenced = {n["next"] for n in by_id.values() if n["next"]}
    heads = [nid for nid in by_id if nid not in referenced]
    if len(heads) != 1:
        warnings.append(f"Beklenen 1 baş; {len(heads)} bulundu (dallanma/eksik).")
    if not heads:
        heads = list(by_id.keys())[:1]
        warnings.append("Baş bulunamadı (olası döngü) → ilk düğümden başlandı.")

    all_paths: List[List[str]] = []
    for head in heads:
        chain: List[str] = []
        seen = set()
        cur = head
        while cur and cur in by_id and cur not in seen:
            seen.add(cur)
            chain.append(cur)
            cur = by_id[cur]["next"]
        if cur and cur in seen:
            warnings.append(f"Döngü: '{cur}' tekrar etti → zincir kesildi.")
        all_paths.append(chain)

    nodes = list(by_id.values())
    for chain in all_paths:
        _finalize_chain(chain, by_id, [])  # depth/path doldur
    max_depth = max((n["depth"] for n in nodes), default=0)
    return {
        "nodes": nodes, "roots": [c[0] for c in all_paths if c], "paths": all_paths,
        "stats": {
            "node_count": len(nodes), "path_count": len(all_paths),
            "max_depth": max_depth, "warnings": warnings,
        },
    }


def _finalize_chain(chain: List[str], by_id: Dict[str, Dict[str, Any]],
                    warnings: List[str]) -> Dict[str, Any]:
    """Bir zincirdeki düğümlere depth/path/parent/children yazar; sonuç döndür."""
    for i, nid in enumerate(chain):
        node = by_id[nid]
        node["depth"] = i
        node["path"] = chain[: i + 1]
        node["parent"] = chain[i - 1] if i > 0 else ""
        node["children"] = [chain[i + 1]] if i + 1 < len(chain) else []
    return {
        "nodes": [by_id[nid] for nid in chain], "roots": [chain[0]] if chain else [],
        "paths": [chain] if chain else [],
        "stats": {
            "node_count": len(chain), "path_count": 1 if chain else 0,
            "max_depth": max(range(len(chain)), default=0), "warnings": warnings,
        },
    }


# ---------------------------------------------------------------------------
# Grouped
# ---------------------------------------------------------------------------

def _build_grouped(rows, config) -> Dict[str, Any]:
    group_col = config.get("group_col")
    label_col = config.get("label_col")
    order_col = config.get("order_col")
    id_col = config.get("id_col")
    warnings: List[str] = []
    if not group_col:
        return _empty_result(["Grouped için group_col gerekli."])

    groups: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        gv = _cell(r, group_col)
        gkey = str(gv) if gv is not None else "(boş)"
        groups.setdefault(gkey, []).append(r)

    if order_col:
        for gkey in groups:
            groups[gkey] = _sort_numeric_then_str(groups[gkey], key=lambda r: _cell(r, order_col))

    nodes: List[Dict[str, Any]] = []
    roots: List[str] = []
    paths: List[List[str]] = []
    seq = 0
    for gkey, rs in groups.items():
        gid = f"group::{gkey}"
        member_ids: List[str] = []
        for r in rs:
            raw_id = r.get(id_col) if id_col else None
            mid = _norm_id(raw_id) if raw_id is not None else f"m_{gkey}_{seq}"
            seq += 1
            label_val = _cell(r, label_col) if label_col else None
            if label_val is None:
                label_val = raw_id if raw_id is not None else mid
            nodes.append({
                "id": mid, "label": str(label_val), "parent": gid, "depth": 1,
                "path": [gid, mid], "type": gkey, "children": [], "row": r,
            })
            member_ids.append(mid)
            paths.append([gid, mid])  # grup → üye (her üye bir yol)
        nodes.append({
            "id": gid, "label": gkey, "parent": "", "depth": 0,
            "path": [gid], "type": "group", "children": member_ids, "row": {},
        })
        roots.append(gid)

    return {
        "nodes": nodes, "roots": roots, "paths": paths,
        "stats": {
            "node_count": len(nodes), "path_count": len(paths),
            "max_depth": 1 if nodes else 0, "warnings": warnings,
        },
    }
