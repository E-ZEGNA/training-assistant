$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputRoot = Join-Path $projectRoot 'reports\interview-audio'
$questionsPath = Join-Path $PSScriptRoot 'interview-questions.json'
$questions = Get-Content -LiteralPath $questionsPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)
try {
  foreach ($question in $questions) {
    $builder = New-Object System.Speech.Synthesis.PromptBuilder
    foreach ($segment in $question.segments) {
      $voice = if ($segment.voice -eq 'en') { 'Microsoft Zira Desktop' } else { 'Microsoft Huihui Desktop' }
      $builder.StartVoice($voice)
      $builder.AppendText($segment.text)
      $builder.EndVoice()
    }
    $file = Join-Path $outputRoot ($question.id + '.wav')
    $synth.SetOutputToWaveFile($file, $format)
    $synth.Speak($builder)
    $synth.SetOutputToNull()
  }
} finally {
  $synth.Dispose()
}

$manifest = $questions | ForEach-Object {
  $file = Join-Path $outputRoot ($_.id + '.wav')
  [pscustomobject]@{ id = $_.id; text = $_.text; file = $file; bytes = (Get-Item -LiteralPath $file).Length }
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'manifest.json') -Encoding UTF8
$manifest | Format-Table id,bytes,text -AutoSize
