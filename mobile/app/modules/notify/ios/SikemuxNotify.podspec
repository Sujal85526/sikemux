Pod::Spec.new do |s|
  s.name           = 'SikemuxNotify'
  s.version        = '0.1.0'
  s.summary        = 'The keys hosts seal notifications with, and the cards they show.'
  s.license        = 'UNLICENSED'
  s.author         = 'Sikemux'
  s.homepage       = 'https://sikemux.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'Module/**/*.swift', 'Shared/**/*.swift'
end
