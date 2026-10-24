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

import re
from typing import Any, Dict, List, Optional

__all__ = ["build_structure"]


def build_structure(structure: str, rows: List[Dict[str, Any]],
                    config: Dict[str, Any]) -> Dict[str, Any]:
    """Yapı tipine göre ilgili kurucuya yönlendir."""
    structure = (structure or "").strip().lower()
    if structure in ("tree", "binary_tree"):
        return _build_tree(rows, config, binary=(structure == "binary_tree"))
    if structure == "sequence":
        return _build_sequence(rows, config)
    if structure == "grouped":
        if config.get("level_cols") or config.get("subgroup_col") or config.get("level2_col"):
            return _build_multi_level(rows, config)
        return _build_grouped(rows, config)
    if structure in ("multi_level", "multilevel", "levels", "hierarchy"):
        return _build_multi_level(rows, config)
    if structure in ("dag", "graph", "network"):
        return _build_dag(rows, config)
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


def _extract_decorations(r: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    """Sağlık puanı, durum, rozet ve renk dekorasyonlarını satırdan çeker."""
    health_col = config.get("health_col") or config.get("health_score_col")
    status_col = config.get("status_col") or config.get("state_col")
    badge_col = config.get("badge_col")
    color_col = config.get("color_col")

    # 1. Health Score
    health_score = None
    if health_col and health_col in r and r[health_col] is not None:
        try:
            health_score = round(float(r[health_col]), 2)
        except (ValueError, TypeError):
            pass
    elif "health_score" in r and r["health_score"] is not None:
        try:
            health_score = round(float(r["health_score"]), 2)
        except (ValueError, TypeError):
            pass
    elif "oee_percent" in r and r["oee_percent"] is not None:
        try:
            health_score = round(float(r["oee_percent"]), 2)
        except (ValueError, TypeError):
            pass

    # 2. Status
    status = None
    if status_col and status_col in r and r[status_col] is not None:
        status = str(r[status_col]).strip()
    elif "status" in r and r["status"] is not None:
        status = str(r["status"]).strip()
    elif "state" in r and r["state"] is not None:
        status = str(r["state"]).strip()
    elif health_score is not None:
        if health_score >= 85:
            status = "HEALTHY"
        elif health_score >= 65:
            status = "WARNING"
        else:
            status = "CRITICAL"

    # 3. Status Color
    status_color = None
    if color_col and color_col in r and r[color_col]:
        status_color = str(r[color_col]).strip()
    elif "status_color" in r and r["status_color"]:
        status_color = str(r["status_color"]).strip()
    elif status:
        st_upper = status.upper()
        if any(x in st_upper for x in ("HEALTHY", "OPERATIONAL", "RUNNING", "ACTIVE", "OPTIMAL", "UP", "PASS")):
            status_color = "#10b981"  # green
        elif any(x in st_upper for x in ("WARNING", "DEGRADED", "STANDBY", "MAINTENANCE", "CAUTION")):
            status_color = "#f59e0b"  # amber
        elif any(x in st_upper for x in ("CRITICAL", "DOWN", "ERROR", "FAILURE", "STOPPED", "FAIL", "ALARM")):
            status_color = "#ef4444"  # red
        else:
            status_color = "#6b7280"  # gray
    elif health_score is not None:
        if health_score >= 85:
            status_color = "#10b981"
        elif health_score >= 65:
            status_color = "#f59e0b"
        else:
            status_color = "#ef4444"

    # 4. Badge
    badge = None
    if badge_col and badge_col in r and r[badge_col] is not None:
        badge = str(r[badge_col])
    elif "badge" in r and r["badge"] is not None:
        badge = str(r["badge"])
    elif health_score is not None:
        badge = f"{health_score}%"
    elif status:
        badge = status

    # 5. Icon & Semantic Type fallback
    icon_col = config.get("icon_col")
    icon = None
    if icon_col and icon_col in r and r[icon_col]:
        icon = str(r[icon_col]).strip()
    elif "icon" in r and r["icon"]:
        icon = str(r["icon"]).strip()

    type_col = config.get("type_col")
    sem_type = None
    if type_col and type_col in r and r[type_col] is not None:
        sem_type = str(r[type_col]).strip()
    else:
        for candidate in ("asset_type", "node_type", "equipment_type", "type", "PATH_LEVEL", "category", "role"):
            if candidate in r and r[candidate] is not None:
                sem_type = str(r[candidate]).strip()
                break

    decorations = {}
    if health_score is not None:
        decorations["healthScore"] = health_score
    if status is not None:
        decorations["status"] = status
    if status_color is not None:
        decorations["statusColor"] = status_color
    if badge is not None:
        decorations["badge"] = badge
    if icon:
        decorations["icon"] = icon
    if sem_type:
        decorations["type"] = sem_type
    return decorations


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
        node_data = {
            "id": nid,
            "label": str(label_val) if label_val is not None else nid,
            "parent": _norm_id(_cell(r, parent_col)),
            "depth": 0, "path": [], "type": "",
            "children": [], "row": r,
        }
        if type_col:
            tv = _cell(r, type_col)
            node_data["type"] = str(tv) if tv is not None else ""
        node_data.update(_extract_decorations(r, config))
        by_id[nid] = node_data
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
        node_data = {
            "id": nid,
            "label": str(label_val) if label_val is not None else nid,
            "parent": "", "depth": 0, "path": [], "type": "", "children": [],
            "next": _norm_id(_cell(r, next_col)) if next_col else "",
            "row": r,
        }
        node_data.update(_extract_decorations(r, config))
        by_id[nid] = node_data

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
# Grouped & Multi-Level Column Hierarchy
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

    # Eğer her grupta sadece 1 satır varsa ve group_col == label_col ise,
    # tüm grupları ortak bir Tesis/Sistem Kökü altında topla ki anlamlı bir ağaç oluşsun.
    all_single_same = (
        len(groups) > 1
        and all(len(rs) == 1 for rs in groups.values())
        and (not label_col or label_col == group_col)
    )
    if all_single_same:
        root_id = "root::overview"
        root_label = config.get("root_label") or "Tesis Genel Görünümü"
        nodes: List[Dict[str, Any]] = []
        member_ids: List[str] = []
        paths: List[List[str]] = []
        scores: List[float] = []
        for gkey, rs in groups.items():
            r = rs[0]
            mid = f"node::{gkey}"
            decos = _extract_decorations(r, config)
            if "healthScore" in decos:
                scores.append(float(decos["healthScore"]))
            mnode = {
                "id": mid, "label": gkey, "parent": root_id, "depth": 1,
                "path": [root_id, mid], "type": decos.get("type") or "area",
                "children": [], "row": r,
            }
            mnode.update(decos)
            nodes.append(mnode)
            member_ids.append(mid)
            paths.append([root_id, mid])

        avg_health = round(sum(scores) / len(scores), 1) if scores else None
        root_node: Dict[str, Any] = {
            "id": root_id, "label": root_label, "parent": "", "depth": 0,
            "path": [root_id], "type": "enterprise", "children": member_ids,
            "row": {"Toplam Küme": len(member_ids), "Ortalama Sağlık": avg_health or "—"},
        }
        if avg_health is not None:
            root_node["healthScore"] = avg_health
            root_node["badge"] = f"{avg_health}%"
        nodes.insert(0, root_node)
        return {
            "nodes": nodes, "roots": [root_id], "paths": paths,
            "stats": {
                "node_count": len(nodes), "path_count": len(paths),
                "max_depth": 1, "warnings": warnings,
            },
        }

    nodes = []
    roots: List[str] = []
    paths = []
    seq = 0
    for gkey, rs in groups.items():
        gid = f"group::{gkey}"
        member_ids = []
        group_scores: List[float] = []
        for r in rs:
            raw_id = r.get(id_col) if id_col else None
            mid = _norm_id(raw_id) if raw_id is not None else f"m_{gkey}_{seq}"
            if mid == gid or any(n["id"] == mid for n in nodes):
                mid = f"{mid}_{seq}"
            seq += 1
            label_val = _cell(r, label_col) if label_col else None
            if label_val is None:
                label_val = raw_id if raw_id is not None else mid
            decos = _extract_decorations(r, config)
            if "healthScore" in decos:
                group_scores.append(float(decos["healthScore"]))
            member_node = {
                "id": mid, "label": str(label_val), "parent": gid, "depth": 1,
                "path": [gid, mid], "type": decos.get("type") or gkey, "children": [], "row": r,
            }
            member_node.update(decos)
            nodes.append(member_node)
            member_ids.append(mid)
            paths.append([gid, mid])  # grup → üye (her üye bir yol)

        avg_h = round(sum(group_scores) / len(group_scores), 1) if group_scores else None
        group_node: Dict[str, Any] = {
            "id": gid, "label": gkey, "parent": "", "depth": 0,
            "path": [gid], "type": "group", "children": member_ids,
            "row": {"Grup": gkey, "Eleman Sayısı": len(member_ids), **({"Ortalama Skor": avg_h} if avg_h is not None else {})},
        }
        if avg_h is not None:
            group_node["healthScore"] = avg_h
            group_node["badge"] = f"{avg_h}%"
            group_node["status"] = "HEALTHY" if avg_h >= 85 else ("WARNING" if avg_h >= 65 else "CRITICAL")
            group_node["statusColor"] = "#10b981" if avg_h >= 85 else ("#f59e0b" if avg_h >= 65 else "#ef4444")
        nodes.append(group_node)
        roots.append(gid)

    return {
        "nodes": nodes, "roots": roots, "paths": paths,
        "stats": {
            "node_count": len(nodes), "path_count": len(paths),
            "max_depth": 1 if nodes else 0, "warnings": warnings,
        },
    }


def _build_multi_level(rows: List[Dict[str, Any]], config: Dict[str, Any]) -> Dict[str, Any]:
    """Herhangi bir düz tablo/sorgudan çok katmanlı kolon hiyerarşisi (L1 → L2 → L3 → Yaprak) kurar."""
    raw_levels = config.get("level_cols")
    if isinstance(raw_levels, str):
        level_cols = [c.strip() for c in raw_levels.split(",") if c.strip()]
    elif isinstance(raw_levels, list):
        level_cols = [str(c).strip() for c in raw_levels if c and str(c).strip()]
    else:
        level_cols = []

    if not level_cols:
        for k in ("group_col", "level1_col", "subgroup_col", "level2_col", "level3_col"):
            v = config.get(k)
            if v and str(v).strip() and str(v).strip() not in level_cols:
                level_cols.append(str(v).strip())

    label_col = config.get("label_col") or config.get("id_col")
    if label_col and label_col not in level_cols:
        level_cols.append(label_col)

    if not level_cols:
        return _empty_result(["Çok katmanlı hiyerarşi için en az 1 kolon (Seviye 1 / Grup) seçilmelidir."])

    nodes_by_id: Dict[str, Dict[str, Any]] = {}
    children_map: Dict[str, List[str]] = {}
    node_scores: Dict[str, List[float]] = {}
    node_counts: Dict[str, int] = {}
    roots: List[str] = []
    leaf_paths: List[List[str]] = []
    warnings: List[str] = []

    for row_idx, r in enumerate(rows):
        chain_ids: List[str] = []
        decos = _extract_decorations(r, config)
        row_score = decos.get("healthScore")

        for depth, col in enumerate(level_cols):
            val = _cell(r, col)
            val_str = str(val).strip() if val is not None and str(val).strip() != "" else f"(Tanımsız {col})"
            parent_id = chain_ids[-1] if chain_ids else ""
            is_last = (depth == len(level_cols) - 1)

            nid = f"L{depth}::{parent_id}::{val_str}" if parent_id else f"L0::{val_str}"
            # Son katmanda aynı isimli birden fazla satır varsa ve id_col farklıysa ayır
            if is_last and config.get("id_col") and config.get("id_col") != col:
                raw_uid = _cell(r, config.get("id_col"))
                if raw_uid is not None:
                    nid = f"{nid}::{raw_uid}"

            chain_ids.append(nid)
            node_counts[nid] = node_counts.get(nid, 0) + 1
            if row_score is not None:
                node_scores.setdefault(nid, []).append(float(row_score))

            if nid not in nodes_by_id:
                node_obj: Dict[str, Any] = {
                    "id": nid,
                    "label": val_str,
                    "parent": parent_id,
                    "depth": depth,
                    "path": list(chain_ids),
                    "type": col,
                    "children": [],
                    "row": r if is_last else {"Seviye": col, "Değer": val_str},
                }
                if is_last:
                    node_obj.update(decos)
                nodes_by_id[nid] = node_obj
                if not parent_id:
                    if nid not in roots:
                        roots.append(nid)
                else:
                    kids = children_map.setdefault(parent_id, [])
                    if nid not in kids:
                        kids.append(nid)

        if chain_ids:
            leaf_paths.append(chain_ids)

    # Ara düğümlere çocuk listesini ve ortalama sağlık skorlarını işle
    for nid, nobj in nodes_by_id.items():
        kids = children_map.get(nid, [])
        nobj["children"] = kids
        if kids:
            nobj["row"] = {
                "Seviye": nobj["type"],
                "Değer": nobj["label"],
                "Alt Düğüm Sayısı": len(kids),
                "Toplam Kayıt": node_counts.get(nid, len(kids)),
            }
            scores = node_scores.get(nid, [])
            if scores:
                avg_s = round(sum(scores) / len(scores), 1)
                nobj["healthScore"] = avg_s
                nobj["badge"] = f"{avg_s}%"
                nobj["status"] = "HEALTHY" if avg_s >= 85 else ("WARNING" if avg_s >= 65 else "CRITICAL")
                nobj["statusColor"] = "#10b981" if avg_s >= 85 else ("#f59e0b" if avg_s >= 65 else "#ef4444")
                nobj["row"]["Ortalama Skor"] = f"{avg_s}%"

    max_depth = max((n["depth"] for n in nodes_by_id.values()), default=0)
    return {
        "nodes": list(nodes_by_id.values()),
        "roots": roots,
        "paths": leaf_paths[:500],
        "stats": {
            "node_count": len(nodes_by_id),
            "path_count": len(leaf_paths),
            "max_depth": max_depth,
            "warnings": warnings,
        },
    }


# ---------------------------------------------------------------------------
# DAG (Directed Acyclic Graph / Multi-parent Graph)
# ---------------------------------------------------------------------------

def _build_dag(rows: List[Dict[str, Any]], config: Dict[str, Any]) -> Dict[str, Any]:
    """Çoklu ebeveynli (multi-parent) yönlendirilmiş çizge (DAG) yapısı kurar."""
    id_col = config.get("id_col")
    parent_col = config.get("parents_col") or config.get("parent_col") or config.get("prereqs_col")
    label_col = config.get("label_col") or id_col
    type_col = config.get("type_col")
    root_value = config.get("root_value")
    warnings: List[str] = []

    if not id_col or not parent_col:
        return _empty_result(["DAG için id_col ve parent_col (veya parents_col) gerekli."])

    by_id: Dict[str, Dict[str, Any]] = {}
    dup = 0
    for r in rows:
        nid = _norm_id(_cell(r, id_col))
        if not nid:
            continue
        if nid in by_id:
            dup += 1
            continue

        raw_parents = _cell(r, parent_col)
        p_list: List[str] = []
        if isinstance(raw_parents, str):
            p_list = [p.strip() for p in re.split(r'[,;|]', raw_parents) if p.strip()]
        elif isinstance(raw_parents, (list, tuple)):
            p_list = [str(p).strip() for p in raw_parents if p is not None and str(p).strip()]
        elif raw_parents not in (None, ""):
            p_list = [str(raw_parents).strip()]

        label_val = _cell(r, label_col)
        node_data = {
            "id": nid,
            "label": str(label_val) if label_val is not None else nid,
            "parents": p_list,
            "parent": p_list[0] if p_list else "",
            "depth": 0,
            "path": [],
            "type": str(_cell(r, type_col)) if type_col and _cell(r, type_col) is not None else "",
            "children": [],
            "row": r,
        }
        node_data.update(_extract_decorations(r, config))
        by_id[nid] = node_data

    if dup:
        warnings.append(f"{dup} tekrarlı id atlandı.")

    # Ebeveynleri doğrula & çocuk haritası kur
    children: Dict[str, List[str]] = {nid: [] for nid in by_id}
    in_degrees: Dict[str, int] = {nid: 0 for nid in by_id}

    for nid, node in by_id.items():
        valid_parents: List[str] = []
        for p in node["parents"]:
            if _is_root(p, root_value) or p == nid:
                continue
            if p not in by_id:
                warnings.append(f"'{nid}'nin parent'ı '{p}' bulunamadı.")
                continue
            valid_parents.append(p)
            children[p].append(nid)

        node["parents"] = valid_parents
        node["parent"] = valid_parents[0] if valid_parents else ""
        in_degrees[nid] = len(valid_parents)

    roots = [nid for nid, deg in in_degrees.items() if deg == 0]
    if not roots and by_id:
        warnings.append("DAG içinde döngü tespit edildi; 0 in-degree kök bulunamadı. İlk düğüm kök seçildi.")
        first_id = next(iter(by_id))
        roots = [first_id]
        in_degrees[first_id] = 0

    # Topolojik seviye (derinlik) ve yolları belirle
    queue = list(roots)
    depths: Dict[str, int] = {nid: 0 for nid in by_id}
    paths_to_node: Dict[str, List[List[str]]] = {r: [[r]] for r in roots}
    visited_topo = set()

    while queue:
        u = queue.pop(0)
        visited_topo.add(u)
        for v in children.get(u, []):
            depths[v] = max(depths[v], depths[u] + 1)
            if v not in paths_to_node:
                paths_to_node[v] = []
            if len(paths_to_node[v]) < 100:
                for p in paths_to_node.get(u, []):
                    if len(paths_to_node[v]) >= 100:
                        break
                    if v not in p:
                        paths_to_node[v].append(p + [v])
            in_degrees[v] -= 1
            if in_degrees[v] == 0:
                queue.append(v)

    unvisited = set(by_id.keys()) - visited_topo
    if unvisited:
        warnings.append(f"DAG döngüsü nedeniyle {len(unvisited)} düğüm topolojik sıraya tam yerleştirilemedi.")
        for u in unvisited:
            depths[u] = max(depths.values(), default=0) + 1
            paths_to_node.setdefault(u, [[u]])

    for nid, node in by_id.items():
        node["depth"] = depths.get(nid, 0)
        node["children"] = children.get(nid, [])
        node_paths = paths_to_node.get(nid, [[nid]])
        node["path"] = node_paths[0] if node_paths else [nid]

    # Yaprak yolları: köklerden çocuksuz düğümlere olan tam yollar
    leaf_paths: List[List[str]] = []
    for nid, node in by_id.items():
        if not node["children"]:
            leaf_paths.extend(paths_to_node.get(nid, []))

    if not leaf_paths and roots:
        leaf_paths = [[r] for r in roots]

    max_return_paths = 500
    if len(leaf_paths) > max_return_paths:
        warnings.append(f"Toplam yol sayısı {len(leaf_paths)}; ilk {max_return_paths} yol döndürülüyor.")
        leaf_paths = leaf_paths[:max_return_paths]

    max_depth = max(depths.values(), default=0)

    return {
        "nodes": list(by_id.values()),
        "roots": roots,
        "paths": leaf_paths,
        "stats": {
            "node_count": len(by_id),
            "path_count": len(leaf_paths),
            "max_depth": max_depth,
            "warnings": warnings,
        },
    }
