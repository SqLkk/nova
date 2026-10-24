import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

export interface AlarmItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  message: string;
  timestamp: string;
  status: 'active' | 'acknowledged' | 'resolved';
  location: string;
  value?: string;
  threshold?: string;
  acknowledgedBy?: string;
  resolvedBy?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AlarmsService {
  private initialAlarms: AlarmItem[] = [
    {
      id: 'alm_1',
      severity: 'critical',
      source: 'CNC İşleme Merkezi E1',
      message: 'Ana iş mili (spindle) sıcaklığı kritik eşiği aştı: 95.4°C (Limit: 85°C)',
      timestamp: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
      status: 'active',
      location: 'Tesis Alpha - Motor Montaj Hattı',
      value: '95.4 °C',
      threshold: '85.0 °C'
    },
    {
      id: 'alm_2',
      severity: 'critical',
      source: 'KUKA Robot KR-210 (Pano 03)',
      message: 'Aks 4 redüktör tork sapması (+%28). Aşırı mekanik sürtünme veya yük algılandı',
      timestamp: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
      status: 'active',
      location: 'Tesis Alpha - Gövde Kaynak İstasyonu',
      value: '128 %',
      threshold: '100 %'
    },
    {
      id: 'alm_3',
      severity: 'critical',
      source: 'Enjeksiyon Pres Makinesi B2',
      message: 'Kalıp hidrolik yağ basıncı 135 bar seviyesine düştü (Gereken minimum: 180 bar)',
      timestamp: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
      status: 'active',
      location: 'Tesis Beta - Plastik Enjeksiyon Hattı',
      value: '135 bar',
      threshold: '180 bar'
    },
    {
      id: 'alm_4',
      severity: 'warning',
      source: 'Apex AX-1500 Master PLC',
      message: 'Endüstriyel Ethernet I/O istasyon 08 yanıt süresi gecikmesi (45ms). Paket kaybı riski',
      timestamp: new Date(Date.now() - 1000 * 60 * 65).toISOString(),
      status: 'active',
      location: 'Tesis Alpha - Hat Otomasyonu',
      value: '45 ms',
      threshold: '20 ms'
    },
    {
      id: 'alm_5',
      severity: 'warning',
      source: 'SMD Reflow Fırın Tüneli',
      message: 'Bölge 3 ön ısıtma profili sapması: +5.8°C termal dalgalanma',
      timestamp: new Date(Date.now() - 1000 * 60 * 95).toISOString(),
      status: 'acknowledged',
      location: 'Tesis Gamma - Elektronik Kart Montajı',
      value: '245.8 °C',
      threshold: '240.0 °C',
      acknowledgedBy: 'Mühendis (engineer)'
    },
    {
      id: 'alm_6',
      severity: 'warning',
      source: 'Konveyör Bandı C-Main',
      message: 'Bant tahrik motorunda titreşim artışı: 2.1 mm/s (Eşik: 1.5 mm/s)',
      timestamp: new Date(Date.now() - 1000 * 60 * 130).toISOString(),
      status: 'active',
      location: 'Tesis Alpha - Şasi Taşıma Hattı',
      value: '2.1 mm/s',
      threshold: '1.5 mm/s'
    },
    {
      id: 'alm_7',
      severity: 'warning',
      source: 'Soğutma Kulesi Pompası P-02',
      message: 'Giriş-çıkış debi farkı tolerans dışı (Debi kaybı: 14 m³/h)',
      timestamp: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
      status: 'active',
      location: 'Tesis Beta - Yardımcı Tesisler',
      value: '42 m³/h',
      threshold: '56 m³/h'
    },
    {
      id: 'alm_8',
      severity: 'warning',
      source: 'Boya Tabancası Püskürtme Ünitesi',
      message: 'Püskürtme nozül hava basıncı kaybı: 4.8 bar (Hedef: 6.0 bar)',
      timestamp: new Date(Date.now() - 1000 * 60 * 220).toISOString(),
      status: 'acknowledged',
      location: 'Tesis Gamma - Son Kat Boya Kabini',
      value: '4.8 bar',
      threshold: '6.0 bar',
      acknowledgedBy: 'Operatör (operator)'
    },
    {
      id: 'alm_9',
      severity: 'info',
      source: 'CNC Torna Ünitesi T-04',
      message: 'Otomatik takım aşınma kompanzasyonu uygulandı (Takım #04, Sapma: 0.012mm)',
      timestamp: new Date(Date.now() - 1000 * 60 * 280).toISOString(),
      status: 'resolved',
      location: 'Tesis Alpha - Hassas Talaşlı İmalat',
      value: '0.012 mm',
      threshold: '0.020 mm',
      resolvedBy: 'Sistem Otomasyonu'
    },
    {
      id: 'alm_10',
      severity: 'info',
      source: 'Enerji Dağıtım Panosu ADP-01',
      message: 'Vardiya reaktif güç kompanzasyonu devrede (Güç Faktörü cos φ = 0.98)',
      timestamp: new Date(Date.now() - 1000 * 60 * 340).toISOString(),
      status: 'resolved',
      location: 'Tesis Alpha - Trafo Merkezi',
      value: '0.98 cos φ',
      threshold: '0.90 cos φ',
      resolvedBy: 'Enerji Yöneticisi'
    },
    {
      id: 'alm_11',
      severity: 'info',
      source: 'Koli Paketleme Robotu R-07',
      message: 'Vardiya hedef parça sayımı tamamlandı: 1.250 adet / 8 saat',
      timestamp: new Date(Date.now() - 1000 * 60 * 410).toISOString(),
      status: 'resolved',
      location: 'Tesis Gamma - Paketleme & Sevkiyat',
      value: '1.250 adet',
      threshold: '1.200 adet',
      resolvedBy: 'Sistem'
    },
    {
      id: 'alm_12',
      severity: 'info',
      source: 'Basınçlı Hava Kompresörü K-02',
      message: 'Otomatik yoğuşma tahliyesi ve hat hava basınç testi başarılı (7.2 bar)',
      timestamp: new Date(Date.now() - 1000 * 60 * 490).toISOString(),
      status: 'resolved',
      location: 'Tesis Beta - Basınçlı Hava Merkezi',
      value: '7.2 bar',
      threshold: '6.5 bar',
      resolvedBy: 'Periyodik Rutin'
    }
  ];

  private alarms: AlarmItem[] = [...this.initialAlarms];

  constructor(private http: HttpClient) {}

  getAlarms(): Observable<AlarmItem[]> {
    return this.http.get<any>('/api/alarms').pipe(
      map(res => (res && res.data && Array.isArray(res.data) && res.data.length > 0) ? res.data : this.alarms),
      catchError(() => of(this.alarms))
    );
  }

  acknowledgeAlarm(id: string, user: string = 'Operatör'): Observable<boolean> {
    const item = this.alarms.find(a => a.id === id);
    if (item) {
      item.status = 'acknowledged';
      item.acknowledgedBy = user;
    }
    return this.http.post<any>(`/api/alarms/${id}/acknowledge`, {}).pipe(
      map(() => true),
      catchError(() => of(true))
    );
  }

  resolveAlarm(id: string, user: string = 'Mühendis'): Observable<boolean> {
    const item = this.alarms.find(a => a.id === id);
    if (item) {
      item.status = 'resolved';
      item.resolvedBy = user;
    }
    return this.http.post<any>(`/api/alarms/${id}/resolve`, {}).pipe(
      map(() => true),
      catchError(() => of(true))
    );
  }

  triggerRandomAlarm(): AlarmItem {
    const severities: ('critical' | 'warning' | 'info')[] = ['critical', 'warning', 'info'];
    const sev = severities[Math.floor(Math.random() * severities.length)];
    const id = `alm_${Date.now()}`;
    const newAlarm: AlarmItem = {
      id,
      severity: sev,
      source: 'CNC Torna Freze İstasyonu E' + Math.floor(Math.random() * 5 + 1),
      message: `Anlık telemetri sapması: ${sev === 'critical' ? 'Kritik sıcaklık artışı tespit edildi (98.2°C)' : 'Yağ seviyesi uyarı limitinde (%18)'}`,
      timestamp: new Date().toISOString(),
      status: 'active',
      location: 'Tesis Alpha - Üretim Hattı',
      value: sev === 'critical' ? '98.2 °C' : '%18',
      threshold: sev === 'critical' ? '85.0 °C' : '%25'
    };
    this.alarms.unshift(newAlarm);
    return newAlarm;
  }
}
