import type { CanonicalReport, ExportFormat, RenderedExport } from './types.ts';
const encoder=new TextEncoder();
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function safeCell(value:unknown):string{let text=value===null?'':typeof value==='string'?value:JSON.stringify(value);if(/^[=+\-@]/u.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;}
export function reportToCsv(report:CanonicalReport):string{
  const lines=['record_type,key,period,channel,metric,count,suppressed,value'];
  const metadata:ReadonlyArray<readonly[string,unknown]>=[['name',report.name],['generated_at',report.generated_at],['scope',report.scope],['filters',report.filters],['as_of',report.as_of],['source_version',report.source_version],['evidence',report.evidence],['included_channels',report.included_channels],['completeness',report.completeness],['known_omissions',report.known_omissions],['overlap_uncertainty',report.overlap_uncertainty],['suppression_threshold',report.suppression_threshold],['unit_definitions',report.unit_definitions],['known_gaps',report.known_gaps]];
  for(const [key,value] of metadata)lines.push(['metadata',key,'','','','','',json(value).trimEnd()].map(safeCell).join(','));
  for(const row of report.rows)lines.push(['row','',row.period,row.channel,row.metric,row.count,row.suppressed,row.suppression_reason].map(safeCell).join(','));
  return lines.join('\r\n')+'\r\n';
}
export function renderReport(report:CanonicalReport,format:ExportFormat):RenderedExport{const text=format==='json'?json(report):reportToCsv(report);return{format,contentType:format==='json'?'application/json; charset=utf-8':'text/csv; charset=utf-8',bytes:encoder.encode(text),report};}
